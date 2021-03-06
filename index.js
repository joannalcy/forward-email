const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const punycode = require('punycode/');
const ip = require('ip');
// const { Resolver } = require('dns');
const spfCheck2 = require('python-spfcheck2');
const isCI = require('is-ci');
const dmarcParse = require('dmarc-parse');
const dkimVerify = require('python-dkim-verify');
const dnsbl = require('dnsbl');
const parseDomain = require('parse-domain');
const autoBind = require('auto-bind');
const { oneLine } = require('common-tags');
const { SMTPServer } = require('smtp-server');
const bytes = require('bytes');
const { MailParser } = require('mailparser');
const nodemailer = require('nodemailer');
const redis = require('redis');
const Limiter = require('ratelimiter');
const ms = require('ms');
const s = require('underscore.string');
const domains = require('disposable-email-domains');
const wildcards = require('disposable-email-domains/wildcard.json');
const validator = require('validator');
const Promise = require('bluebird');
const _ = require('lodash');
const uniq = require('lodash/uniq');
const addressParser = require('nodemailer/lib/addressparser');

let mailUtilities = require('mailin/lib/mailUtilities.js');

mailUtilities = Promise.promisifyAll(mailUtilities);

// currently running into this error when using this code:
// `Error: Mail command failed: 421 Cannot read property '_handle' of undefined`
// const resolver = new Resolver();
// resolver.setServers(servers);
// const resolveMx = Promise.promisify(resolver.resolveMx);
// const resolveTxt = Promise.promisify(resolver.resolveTxt);

const blacklist = require('./blacklist');

const invalidTXTError = new Error('Invalid forward-email TXT record');
invalidTXTError.responseCode = 550;

const invalidMXError = new Error('Sender has invalid MX records');
invalidMXError.responseCode = 550;

const headers = [
  'subject',
  'references',
  'date',
  'to',
  'from',
  'to',
  'cc',
  'bcc',
  'message-id',
  'in-reply-to',
  'reply-to'
];

const log = process.env.NODE_ENV !== 'production';

if (log) Error.stackTraceLimit = Infinity;

// taken from:
// node_modules/nodemailer/lib/mime-node/index.js
function createMessageID(session) {
  return (
    '<' +
    [2, 2, 2, 6].reduce(
      // crux to generate UUID-like random strings
      (prev, len) => prev + '-' + crypto.randomBytes(len).toString('hex'),
      crypto.randomBytes(4).toString('hex')
    ) +
    '@' +
    // try to use the domain of the FROM address
    session.envelope.mailFrom.address.split('@').pop() +
    '>'
  );
}

class ForwardEmail {
  constructor(config = {}) {
    this.ssl = {
      secure: false,
      ...config.ssl
    };

    if (process.env.NODE_ENV === 'test' && !isCI)
      config.dkim = {
        domainName: 'forwardemail.net',
        keySelector: 'default',
        privateKey: fs.readFileSync(
          path.join(__dirname, 'dkim-private.key'),
          'utf8'
        )
      };

    this.config = {
      // TODO: eventually set 127.0.0.1 as DNS server
      // for both `dnsbl` and `dns` usage
      // https://gist.github.com/zhurui1008/48130439a079a3c23920
      // currently we use Open DNS instead
      dns: ['208.67.222.222', '208.67.220.220'],
      noReply: 'no-reply@forwardemail.net',
      smtp: {
        size: bytes('25mb'),
        onConnect: this.onConnect.bind(this),
        onData: this.onData.bind(this),
        onMailFrom: this.onMailFrom.bind(this),
        onRcptTo: this.onRcptTo.bind(this),
        disabledCommands: ['AUTH'],
        logInfo: log,
        logger: log,
        ...config.smtp,
        ...this.ssl
      },
      limiter: { ...config.limiter },
      ssl: this.ssl,
      exchanges: ['mx1.forwardemail.net', 'mx2.forwardemail.net'],
      dkim: {},
      ...config
    };

    // setup rate limiting with redis
    this.limiter = {
      db: redis.createClient(),
      max: 200, // max requests within duration
      duration: ms('1h'),
      ...this.config.limiter
    };

    // setup our smtp server which listens for incoming email
    this.server = new SMTPServer(this.config.smtp);

    this.dns = Promise.promisifyAll(dns);
    this.dns.setServers(this.config.dns);

    autoBind(this);
  }

  rewriteFriendlyFrom(mail) {
    // preserve user's name
    const { name } = addressParser(mail.from)[0];
    let replyTo = mail.from;
    // do not overwrite existing reply-to
    if (
      _.isObject(mail.replyTo) &&
      _.isArray(mail.replyTo.value) &&
      _.isObject(mail.replyTo.value[0]) &&
      _.isString(mail.replyTo.value[0].address) &&
      _.isString(mail.replyTo.value[0].name)
    ) {
      // if no name then don't use `<> format`
      if (mail.replyTo.value[0].name === '')
        replyTo = mail.replyTo.value[0].address;
      else
        replyTo = `${mail.replyTo.value[0].name} <${
          mail.replyTo.value[0].address
        }>`;
    }

    return {
      replyTo,
      from: `${name} <${this.config.noReply}>`
    };
  }

  parseUsername(address) {
    ({ address } = addressParser(address)[0]);
    let username =
      address.indexOf('+') === -1
        ? address.split('@')[0]
        : address.split('+')[0];

    username = punycode.toASCII(username).toLowerCase();
    return username;
  }

  parseFilter(address) {
    ({ address } = addressParser(address)[0]);
    return address.indexOf('+') === -1
      ? ''
      : address.split('+')[1].split('@')[0];
  }

  parseDomain(address) {
    let domain = addressParser(address)[0].address.split('@')[1];
    domain = punycode.toASCII(domain);

    // check against blacklist
    if (this.isBlacklisted(domain)) {
      const err = new Error('Blacklisted domains are not permitted');
      err.responseCode = 550;
      throw err;
    }

    // ensure fully qualified domain name
    if (!validator.isFQDN(domain)) {
      const err = new Error(`${domain} is not a FQDN`);
      err.responseCode = 550;
      throw err;
    }

    // prevent disposable email addresses from being used
    if (this.isDisposable(domain)) {
      const err = new Error('Disposable email addresses are not permitted');
      err.responseCode = 550;
      throw err;
    }

    return domain;
  }

  async onConnect(session, fn) {
    // TODO: this needs tested in production
    // or we need to come up with a better way to do this
    if (process.env.NODE_ENV === 'test') return fn();
    // ensure it's a fully qualififed domain name
    if (!validator.isFQDN(session.clientHostname)) {
      const err = new Error(`${session.clientHostname} is not a FQDN`);
      err.responseCode = 550;
      return fn(err);
    }

    // ensure that it's not on the DNS blacklist
    try {
      const result = await dnsbl.lookup(
        session.remoteAddress,
        'zen.spamhaus.org',
        {
          servers: this.config.dns
        }
      );
      if (!result) return fn();
      const error = new Error(
        `Your IP address of ${
          session.remoteAddress
        } is listed on the ZEN Spamhaus DNS Blacklist.  See https://www.spamhaus.org/query/ip/${
          session.remoteAddress
        } for more information.`
      );
      error.responseCode = 554;
      fn(error);
    } catch (err) {
      if (log) console.error(err);
      fn();
    }
  }

  onData(stream, session, fn) {
    // <https://github.com/nodemailer/mailparser/blob/master/examples/pipe.js>
    const parser = new MailParser();
    const mail = { attachments: [] };
    let hasDKIMSignature = false;
    let rawEmail = '';

    stream.on('error', fn);

    parser.on('error', err => {
      stream.emit('error', err);
      parser.end();
    });

    // eslint-disable-next-line complexity
    parser.on('end', async () => {
      try {
        // check if we had a DKIM signature on the email
        hasDKIMSignature = mail.headers.has('dkim-signature');

        headers.forEach(key => {
          if (mail.headers.has(key)) {
            const formatted = key.replace(/-([a-z])/g, (m, c) =>
              c.toUpperCase()
            );
            mail[formatted] = mail.headers.get(key);
            mail.headers.delete(key);
            if (['to', 'from', 'cc', 'bcc'].includes(key)) {
              mail[formatted] = mail[formatted].text;
            }
          }
        });

        if (
          _.some(
            session.envelope.rcptTo,
            to => to.address === this.config.noReply
          )
        ) {
          const err = new Error(
            oneLine`You need to reply to the "Reply-To" email address on the email; do not send messages to <${
              this.config.noReply
            }>`
          );
          err.responseCode = 550;
          throw err;
        }

        const { rcptTo } = session.envelope;
        session.envelope.rcptTo = await Promise.map(rcptTo, async to => {
          const address = await this.getForwardingAddress(to.address);
          // Gmail won't show the message in the inbox if it's sending FROM
          // the same address that gets forwarded TO using our service
          // (we can assume that other mail providers do the same)
          const fromAddress = addressParser(mail.from)[0].address;
          if (address === fromAddress) {
            if (mail.messageId) mail.inReplyTo = mail.messageId;
            mail.messageId = createMessageID(session);
          }

          return {
            ...to,
            address
          };
        });

        session.envelope = {
          from: session.envelope.mailFrom.address,
          // make sure it's unique so we don't send dups
          to: uniq(session.envelope.rcptTo.map(to => to.address))
        };

        mail.headers = [...mail.headers].reduce((obj, [key, value]) => {
          if (_.isObject(value)) {
            if (_.isString(value.value)) obj[key] = value.value;
            if (_.isObject(value.params))
              Object.keys(value.params).forEach(k => {
                obj[key] += `; ${k}=${value.params[k]}`;
              });
          } else {
            obj[key] = value;
          }

          return obj;
        }, {});

        const obj = {
          ...mail
          // envelope: session.envelope
        };

        if (['test', 'development'].includes(process.env.NODE_ENV))
          console.dir(obj);

        const spf = await this.validateSPF(
          session.remoteAddress,
          session.envelope.from,
          // addressParser(mail.from)[0].address,
          session.clientHostname
        );

        // if it didn't have a valid SPF record
        // then we need to rewrite with a friendly-from
        // (so we do not land in the spam folder)
        if (!['pass', 'neutral', 'none', 'softfail'].includes(spf)) {
          const err = new Error(
            oneLine`
              The email you sent has failed SPF validation with a result of "${spf}".  Please try again or check your email service's SPF configuration.\n
              If you believe this is an error, please forward this email to: support@forwardemail.net
            `
          );
          err.responseCode = 550;
          throw err;
        }

        // now we need to do a reverse-SPF lookup
        // so we prevent emails from Amazon/Twitch going to spam
        // since Amazon/Twitch for example obviously don't allow us
        // as a sender within their SPF records
        // but note that this must come before DMARC validation
        const reverseSpf = await this.validateSPF(
          ip.address(), // our server's current IP address
          session.envelope.from, // the original FROM address
          // TODO: eventually we need a way to map which IP
          // is to which exchange/FQDN without assuming it's the first
          this.config.exchanges[0] // our server's FQDN (pick the first)
        );

        if (!['pass', 'neutral', 'none'].includes(reverseSpf)) {
          const { replyTo, from } = this.rewriteFriendlyFrom(mail);
          obj.replyTo = replyTo;
          obj.from = from;
          mail.from = from;
          session.envelope.from = from;
        }

        const dkim = hasDKIMSignature
          ? await this.validateDKIM(rawEmail)
          : true;

        // if there was no valid SPF record found for this sender
        // AND if there was no valid DKIM signature on the message
        // then we must refuse sending this email along because it
        // literally has on validation that it's from who it says its from
        if (!dkim) {
          const err = new Error(
            oneLine`
              The email you sent has an invalid DKIM signature, please try again or check your email service's DKIM configuration.\n
              If you believe this is an error, please forward this email to: support@forwardemail.net
            `
          );
          err.responseCode = 550;
          throw err;
        }

        //
        // if SPF failed that means the sender did not designate
        // us as a proxy/middleman (e.g. Amazon.com or Twitch.com)
        // and so we need to rewrite the FROM with friendly-from
        // and make the reply to be the original FROM address
        //
        // (so we don't want it to land in the user's inbox with failed SPF)
        //
        // TODO: here is where we'd implement ARC (but still SPF would fail)
        //

        //
        // TODO: we need to replace the spam block below with implementation
        // of `pdf-spamc-stream` from https://github.com/streamtOtO/spamc-stream
        // note that this package name is published with several key updates
        //

        // https://www.npmjs.com/package/pdf-spamc-stream
        // (vs)
        // https://www.npmjs.com/package/spamc-stream
        //
        // check against spamd if this message is spam
        // <https://github.com/humantech/node-spamd#usage>
        //
        // note that we wrap with a try/catch due to this error
        /*
        0|smtp     | error: TypeError: Cannot read property '2' of null
        0|smtp     |     at processResponse (/var/www/production/source/node_modules/spamc/index.js:381:43)
        0|smtp     |     at /var/www/production/source/node_modules/spamc/index.js:99:28
        0|smtp     |     at Socket.<anonymous> (/var/www/production/source/node_modules/spamc/index.js:327:28)
        0|smtp     |     at Socket.emit (events.js:182:13)
        0|smtp     |     at Socket.EventEmitter.emit (domain.js:442:20)
        0|smtp     |     at TCP._handle.close (net.js:595:12)
        */
        let spamScore = 0;
        try {
          spamScore = await mailUtilities.computeSpamScoreAsync(rawEmail);
        } catch (err) {
          if (log) console.error(err);
        }

        if (spamScore >= 5) {
          // TODO: blacklist IP address
          const err = new Error(
            `Message detected as spam (spam score was ${spamScore})`
          );
          err.responseCode = 554;
          throw err;
        }

        // TODO: implement spamassassin automatic learning
        // through bayes based off response from proxy (e.g. gmail response)
        // (if spam errors occur, we need 550 error code)
        // and we also might want to add clamav
        // for attachment scanning to prevent those from going through as well

        // since we're signing our own DKIM signature
        // we need to delete appropriate headers to prevent failure
        delete mail.headers['mime-version'];
        delete mail.headers['content-type'];
        delete mail.headers['dkim-signature'];
        delete mail.headers['x-google-dkim-signature'];

        // added support for DMARC validation
        // recursively lookup the DMARC policy for the FROM address
        // and if it exists then we need to rewrite with a friendly-from
        // so we need to resolve the TXT record for `_.dmarc.tld`
        const dmarcRecord = await this.getDMARC(
          session.envelope.from.split('@')[1]
          // addressParser(mail.from)[0].address.split('@')[1]
        );

        if (dmarcRecord) {
          try {
            const result = dmarcParse(dmarcRecord);
            if (
              !_.isObject(result) ||
              !_.isObject(result.tags) ||
              !_.isObject(result.tags.p) ||
              !_.isString(result.tags.p.value)
            )
              throw new Error('Invalid DMARC parsed result');
            // if quarantine or reject then we need to rewrite w/friendly-from
            if (
              ['quarantine', 'reject'].includes(
                result.tags.p.value.toLowerCase().trim()
              )
            ) {
              const { replyTo, from } = this.rewriteFriendlyFrom(mail);
              obj.replyTo = replyTo;
              obj.from = from;
              mail.from = from;
              session.envelope.from = from;
            }
          } catch (err) {
            if (log) console.error(err);
          }
        }

        // NOTE: we probably don't need to delete these
        // but just keeping them here for future reference
        // delete mail.messageId;
        // delete mail.headers['x-gm-message-state'];
        // delete mail.headers['x-google-smtp-source'];
        // delete mail.headers['x-received'];
        // delete mail.headers['x-google-address-confirmation'];

        // TODO: note that if one email fails then all will fail right now
        // send an email to each recipient
        await Promise.each(session.envelope.to, async to => {
          // TODO: pick lowest priority address found
          const addresses = await this.validateMX(to);
          const transporter = nodemailer.createTransport({
            debug: log,
            logger: log,
            direct: true,
            // secure: true,
            // requireTLS: true,
            opportunisticTLS: true,
            port: 25,
            host: addresses[0].exchange,
            ...this.ssl,
            name: os.hostname(),
            tls: {
              rejectUnauthorized: process.env.NODE_ENV !== 'test'
            }
            // <https://github.com/nodemailer/nodemailer/issues/625>
          });

          // verify transport
          // await transporter.verify();

          const email = {
            ...obj,
            envelope: session.envelope,
            dkim: this.config.dkim
          };

          const info = await transporter.sendMail(email);
          return info;
        });

        fn();
      } catch (err) {
        // parse SMTP code and message
        if (err.message && err.message.startsWith('SMTP code:')) {
          err.responseCode = err.message.split('SMTP code:')[1].split(' ')[0];
          err.message = err.message.split('msg:')[1];
          // TODO: we need to use bayes auto learning here
          // to tell spam assassin that this email in particular failed
          // (IFF as it was sent to a gmail, yahoo, or other major provider)
        }

        // add a note to email me for help
        err.message +=
          '\n\n If you need help please forward this email to support@forwardemail.net or visit https://forwardemail.net';
        if (log) console.error(err);
        fn(err);
      }
    });

    stream.on('data', chunk => {
      rawEmail += chunk;
    });

    stream.on('end', () => {
      if (stream.sizeExceeded) {
        const err = new Error(
          `Message size exceeds maximum of ${bytes(this.config.smtp.size)}`
        );
        err.responseCode = 450;
        parser.emit('error', err);
      }
    });

    parser.on('headers', headers => {
      mail.headers = headers;
    });

    parser.on('data', data => {
      if (data.type === 'text') {
        Object.keys(data).forEach(key => {
          if (['text', 'html', 'textAsHtml'].includes(key)) {
            mail[key] = data[key];
          }
        });
      }

      if (data.type === 'attachment') {
        const chunks = [];
        let chunklen = 0;

        mail.attachments.push(data);

        data.content.on('readable', () => {
          let chunk;
          while ((chunk = data.content.read()) !== null) {
            chunks.push(chunk);
            chunklen += chunk.length;
          }
        });

        data.content.on('end', () => {
          data.content = Buffer.concat(chunks, chunklen);
          data.release();
        });
      }
    });

    stream.pipe(parser);
  }

  // TODO: we need to add Google Structured Data and then submit whitelist req

  //
  // basically we have to check if the domain has an SPF record
  // if it does, then we need to check if the sender's domain is included
  //
  // if any errors occur, we should respond with this:
  // err.message = 'SPF validation error';
  // err.responseCode = 451;
  //
  // however if it's something like a network error
  // we should respond with a `421` code as we do below
  //
  async validateSPF(remoteAddress, from, clientHostname) {
    if (process.env.NODE_ENV === 'test') {
      remoteAddress = '178.128.149.101';
      clientHostname = 'mx1.forwardemail.net';
    }

    try {
      const [result, explanation] = await spfCheck2(
        remoteAddress,
        from,
        clientHostname
      );
      if (['permerror', 'temperror'].includes(result))
        throw new Error(
          `SPF validation failed with result "${result}" and explanation "${explanation}"`
        );
      return result;
    } catch (err) {
      err.responseCode = 421;
      throw err;
    }
  }

  async getDMARC(hostname) {
    if (process.env.NODE_ENV === 'test') hostname = 'forwardemail.net';
    const parsedDomain = parseDomain(hostname);
    if (!parsedDomain) return false;
    const entry = `_dmarc.${hostname}`;
    try {
      const records = await dns.resolveTxtAsync(entry);
      // note that it's an array of arrays [ [ 'v=DMARC1' ] ]
      if (!_.isArray(records) || _.isEmpty(records)) return false;
      if (!_.isArray(records[0]) || _.isEmpty(records[0])) return false;
      // join together the record by space
      return records[0].join(' ');
    } catch (err) {
      // recursively look up from subdomain to parent domain for record
      if (_.isString(err.code) && err.code === 'ENOTFOUND') {
        // no dmarc record exists so return `false`
        if (!parsedDomain.subdomain) return false;
        // otherwise attempt to lookup the parent domain's DMARC record instead
        return this.getDMARC(`${parsedDomain.domain}.${parsedDomain.tld}`);
      }

      if (log) console.error(err);
      // if there's an error then assume that we need to rewrite
      // with a friendly-from, for whatever reason
      return true;
    }
  }

  async validateDKIM(rawEmail) {
    try {
      const result = await dkimVerify(Buffer.from(rawEmail, 'utf8'));
      return result;
    } catch (err) {
      if (log) console.error(err);
      err.responseCode = 421;
      throw err;
    }
  }

  async validateMX(address) {
    try {
      const domain = this.parseDomain(address);
      const addresses = await dns.resolveMxAsync(domain);
      if (!addresses || addresses.length === 0) throw invalidMXError;
      return _.sortBy(addresses, 'priority');
    } catch (err) {
      if (/queryMx ENODATA/.test(err) || /queryTxt ENOTFOUND/.test(err)) {
        err.message = invalidMXError.message;
        err.responseCode = invalidMXError.responseCode;
      } else if (!err.responseCode) {
        err.responseCode = 421;
      }

      throw err;
    }
  }

  validateRateLimit(email) {
    // if SPF TXT record exists for the domain name
    // then ensure that `session.remoteAddress` resolves
    // to either the IP address or the domain name value for the SPF
    return new Promise((resolve, reject) => {
      if (email === this.config.noReply) return resolve();
      const id = email;
      const limit = new Limiter({ id, ...this.limiter });
      limit.get((err, limit) => {
        if (err) {
          err.responseCode = 421;
          return reject(err);
        }

        if (limit.remaining) return resolve();
        const delta = (limit.reset * 1000 - Date.now()) | 0;
        err = new Error(
          `Rate limit exceeded, retry in ${ms(delta, { long: true })}`
        );
        err.responseCode = 451;
        reject(err);
      });
    });
  }

  isBlacklisted(domain) {
    return blacklist.includes(domain);
  }

  isDisposable(domain) {
    for (const d of domains) {
      if (d === domain) return true;
    }

    for (const w of wildcards) {
      if (w === domain || domain.endsWith(`.${w}`)) return true;
    }

    return false;
  }

  async onMailFrom(address, session, fn) {
    try {
      await this.validateRateLimit(address.address);
      await this.validateMX(address.address);
      fn();
    } catch (err) {
      fn(err);
    }
  }

  // this returns the forwarding address for a given email address
  async getForwardingAddress(address) {
    const domain = this.parseDomain(address);
    const records = await dns.resolveTxtAsync(domain);

    // dns TXT record must contain `forward-email=` prefix
    const validRecords = [];

    // add support for multi-line TXT records
    for (let i = 0; i < records.length; i++) {
      records[i] = records[i].join(''); // join chunks together
      if (records[i].startsWith('forward-email='))
        validRecords.push(records[i].replace('forward-email=', ''));
    }

    // join multi-line TXT records together and replace double w/single commas
    const record = validRecords
      .join(',')
      .replace(/,+/g, ',')
      .trim();

    // if the record was blank then throw an error
    if (s.isBlank(record)) throw invalidTXTError;

    // e.g. hello@niftylettuce.com => niftylettuce@gmail.com
    // record = "forward-email=hello:niftylettuce@gmail.com"
    // e.g. hello+test@niftylettuce.com => niftylettuce+test@gmail.com
    // record = "forward-email=hello:niftylettuce@gmail.com"
    // e.g. *@niftylettuce.com => niftylettuce@gmail.com
    // record = "forward-email=niftylettuce@gmail.com"
    // e.g. *+test@niftylettuce.com => niftylettuce@gmail.com
    // record = "forward-email=niftylettuce@gmail.com"

    // remove trailing whitespaces from each address listed
    const addresses = record.split(',').map(a => a.trim());

    if (addresses.length === 0) throw invalidTXTError;

    // store if we have a forwarding address or not
    let forwardingAddress;

    // store if we have a global redirect or not
    let globalForwardingAddress;

    // check if we have a specific redirect and store global redirects (if any)
    // get username from recipient email address
    // (e.g. hello@niftylettuce.com => hello)
    const username = this.parseUsername(address);

    for (let i = 0; i < addresses.length; i++) {
      // convert addresses to lowercase
      addresses[i] = addresses[i].toLowerCase();
      if (addresses[i].indexOf(':') === -1) {
        if (
          validator.isFQDN(this.parseDomain(addresses[i])) &&
          validator.isEmail(addresses[i])
        )
          globalForwardingAddress = addresses[i];
      } else {
        const address = addresses[i].split(':');

        if (address.length !== 2) throw invalidTXTError;

        // address[0] = hello (username)
        // address[1] = niftylettuce@gmail.com (forwarding email)

        // check if we have a match
        if (username === address[0]) {
          forwardingAddress = address[1];
          break;
        }
      }
    }

    // if we don't have a specific forwarding address try the global redirect
    if (!forwardingAddress && globalForwardingAddress)
      forwardingAddress = globalForwardingAddress;

    // if we don't have a forwarding address then throw an error
    if (!forwardingAddress) throw invalidTXTError;

    // otherwise transform the + symbol filter if we had it
    // and then resolve with the newly formatted forwarding address
    if (address.indexOf('+') === -1) return forwardingAddress;

    return `${this.parseUsername(forwardingAddress)}+${this.parseFilter(
      address
    )}@${this.parseDomain(forwardingAddress)}`;
  }

  async onRcptTo(address, session, fn) {
    try {
      // validate forwarding address by looking up TXT record `forward-email=`
      await this.getForwardingAddress(address.address);

      // validate MX records exist and contain ours
      const addresses = await this.validateMX(address.address);
      const exchanges = addresses.map(mxAddress => mxAddress.exchange);
      const hasAllExchanges = this.config.exchanges.every(exchange =>
        exchanges.includes(exchange)
      );
      if (hasAllExchanges) return fn();
      const err = new Error(
        `Missing required DNS MX records: ${this.config.exchanges.join(', ')}`
      );
      err.responseCode = 550;
      throw err;
    } catch (err) {
      fn(err);
    }
  }
}

if (!module.parent) {
  const config = {
    noReply: 'no-reply@forwardemail.net',
    exchanges: ['mx1.forwardemail.net', 'mx2.forwardemail.net'],
    ssl: {},
    dkim: {}
  };

  if (process.env.NODE_ENV === 'production') {
    // needsUpgrade = true;
    config.ssl = {
      secure: process.env.SECURE === 'true',
      key: fs.readFileSync('/home/deploy/mx1.forwardemail.net.key', 'utf8'),
      cert: fs.readFileSync('/home/deploy/mx1.forwardemail.net.cert', 'utf8'),
      ca: fs.readFileSync('/home/deploy/mx1.forwardemail.net.ca', 'utf8')
    };
    config.dkim = {
      domainName: 'forwardemail.net',
      keySelector: 'default',
      privateKey: fs.readFileSync('/home/deploy/dkim-private.key', 'utf8')
    };
  }

  const forwardEmail = new ForwardEmail(config);
  forwardEmail.server.listen(process.env.PORT || 25);
}

module.exports = ForwardEmail;
