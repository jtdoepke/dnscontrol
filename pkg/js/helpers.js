'use strict';

// If you edit this file, you must run `go generate` to embed this
// file in the source code.

// If you are heavily debugging this code, the "-dev" flag will
// read this file directly instead of using the output of
// `go generate`. You'll still need to run `go generate` before
// you commit the changes.

var conf = {
    registrars: [],
    dns_providers: [],
    domains: [],
    domain_names: [],
};

var defaultArgs = [];

function initialize() {
    conf = {
        registrars: [],
        dns_providers: [],
        domains: [],
    };
    defaultArgs = [];
}

function _isDomain(d) {
  return _.isArray(d.nameservers) && _.isArray(d.records) && _.isString(d.name);
}

// Returns an array of domains which were registered so far during runtime
// Own function for compatibility reasons or if some day special processing would be required.
function getConfiguredDomains() {
    return conf.domain_names;
}

function NewRegistrar(name, type, meta) {
    if (type) {
        type == 'MANUAL';
    }
    var reg = { name: name, type: type, meta: meta };
    conf.registrars.push(reg);
    return name;
}

function NewDnsProvider(name, type, meta) {
    if (typeof meta === 'object' && 'ip_conversions' in meta) {
        meta.ip_conversions = format_tt(meta.ip_conversions);
    }
    var dsp = { name: name, type: type, meta: meta };
    conf.dns_providers.push(dsp);
    return name;
}

function newDomain(name, registrar) {
    return {
        name: name,
        subdomain: '',
        registrar: registrar,
        meta: {},
        records: [],
        dnsProviders: {},
        defaultTTL: 0,
        nameservers: [],
        ignored_names: [],
        ignored_targets: [],
    };
}

function processDargs(m, domain) {
    // for each modifier, if it is a...
    // function: call it with domain
    // array: process recursively
    // object: merge it into metadata
    if (_.isFunction(m)) {
        m(domain);
    } else if (_.isArray(m)) {
        for (var j in m) {
            processDargs(m[j], domain);
        }
    } else if (_.isObject(m)) {
        _.extend(domain.meta, m);
    } else {
        throw 'WARNING: domain modifier type unsupported: ' +
            typeof m +
            ' Domain: ' +
            domain.name;
    }
}

// D(name,registrar): Create a DNS Domain. Use the parameters as records and mods.
function D(name, registrar) {
    var domain = newDomain(name, registrar);
    for (var i = 0; i < defaultArgs.length; i++) {
        processDargs(defaultArgs[i], domain);
    }
    for (var i = 2; i < arguments.length; i++) {
        var m = arguments[i];
        processDargs(m, domain);
    }
    if (conf.domain_names.indexOf(name) !== -1) {
        throw name + ' is declared more than once';
    }
    conf.domains.push(domain);
    conf.domain_names.push(name);
}

function INCLUDE(name) {
    var domain = _getDomainObject(name);
    if (domain == null) {
        throw name + ' was not declared yet and therefore cannot be updated. Use D() before.';
    }
    return function(d) {
      d.records.push.apply(d.records, domain.obj.records);
    }
}

// D_EXTEND(name): Update a DNS Domain already added with D(), or subdomain thereof
function D_EXTEND(name) {
    var domain = _getDomainObject(name);
    if (domain == null) {
        throw name + ' was not declared yet and therefore cannot be updated. Use D() before.';
    }
    domain.obj.subdomain = name.substr(0, name.length-domain.obj.name.length - 1);
    for (var i = 1; i < arguments.length; i++) {
        var m = arguments[i];
        processDargs(m, domain.obj);
    }
    conf.domains[domain.id] = domain.obj; // let's overwrite the object.
}

// _getDomainObject(name): This implements the domain matching
// algorithm used by D_EXTEND(). Candidate matches are an exact match
// of the domain's name, or if name is a proper subdomain of the
// domain's name. The longest match is returned.
function _getDomainObject(name) {
    var domain = null;
    var domainLen = 0;
    for (var i = 0; i < conf.domains.length; i++) {
        var thisName = conf.domains[i]["name"];
        var desiredSuffix = "." + thisName;
        var foundSuffix = name.substr(-desiredSuffix.length);
        // If this is an exact match or the suffix matches...
        if (name === thisName || foundSuffix === desiredSuffix) {
            // If this match is a longer match than our current best match...
            if (thisName.length > domainLen) {
                domainLen = thisName.length;
                domain = { id: i, obj: conf.domains[i] };
            }
        }
    }
    return domain;
}

// DEFAULTS provides a set of default arguments to apply to all future domains.
// Each call to DEFAULTS will clear any previous values set.
function DEFAULTS() {
    defaultArgs = [];
    for (var i = 0; i < arguments.length; i++) {
        defaultArgs.push(arguments[i]);
    }
}

// TTL(v): Set the TTL for a DNS record.
function TTL(v) {
    if (_.isString(v)) {
        v = stringToDuration(v);
    }
    return function(r) {
        r.ttl = v;
    };
}

function stringToDuration(v) {
    var matches = v.match(/^(\d+)([smhdwny]?)$/);
    if (matches == null) {
        throw v + ' is not a valid duration string';
    }
    unit = 's';
    if (matches[2]) {
        unit = matches[2];
    }
    v = parseInt(matches[1]);
    var u = { s: 1, m: 60, h: 3600 };
    u['d'] = u.h * 24;
    u['w'] = u.d * 7;
    u['n'] = u.d * 30;
    u['y'] = u.d * 365;
    v *= u[unit];
    return v;
}

// DefaultTTL(v): Set the default TTL for the domain.
function DefaultTTL(v) {
    if (_.isString(v)) {
        v = stringToDuration(v);
    }
    return function(d) {
        d.defaultTTL = v;
    };
}

function makeCAAFlag(value) {
    return function(record) {
        record.caaflag |= value;
    };
}

// CAA_CRITICAL: Critical CAA flag
var CAA_CRITICAL = makeCAAFlag(1 << 7);

// DnsProvider("providerName", 0)
// nsCount of 0 means don't use or register any nameservers.
// nsCount not provider means use all.
function DnsProvider(name, nsCount) {
    if (typeof nsCount === 'undefined') {
        nsCount = -1;
    }
    return function(d) {
        d.dnsProviders[name] = nsCount;
    };
}

// A(name,ip, recordModifiers...)
var A = recordBuilder('A');

// AAAA(name,ip, recordModifiers...)
var AAAA = recordBuilder('AAAA');

// AKAMAICDN(name, target, recordModifiers...)
var AKAMAICDN = recordBuilder('AKAMAICDN');

// ALIAS(name,target, recordModifiers...)
var ALIAS = recordBuilder('ALIAS');

// AZURE_ALIAS(name, type, target, recordModifiers...)
var AZURE_ALIAS = recordBuilder('AZURE_ALIAS', {
    args: [
        ['name', _.isString],
        ['type', validateAzureAliasType],
        ['target', _.isString],
    ],
    transform: function(record, args, modifier) {
        record.name = args.name;
        record.target = args.target;
        if (_.isObject(record.azure_alias)) {
            record.azure_alias['type'] = args.type;
        } else {
            record.azure_alias = { type: args.type };
        }
    },
});

function validateAzureAliasType(value) {
    if (!_.isString(value)) {
        return false;
    }
    return ['A', 'AAAA', 'CNAME'].indexOf(value) !== -1;
}

// R53_ALIAS(name, target, type, recordModifiers...)
var R53_ALIAS = recordBuilder('R53_ALIAS', {
    args: [
        ['name', _.isString],
        ['type', validateR53AliasType],
        ['target', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.target = args.target;
        if (_.isObject(record.r53_alias)) {
            record.r53_alias['type'] = args.type;
        } else {
            record.r53_alias = { type: args.type };
        }
    },
});

// R53_ZONE(zone_id)
function R53_ZONE(zone_id) {
    return function (r) {
        if (_isDomain(r)) {
            r.meta.zone_id = zone_id;
        } else if (_.isObject(r.r53_alias)) {
            r.r53_alias['zone_id'] = zone_id;
        } else {
            r.r53_alias = { zone_id: zone_id };
        }
    };
}

function validateR53AliasType(value) {
    if (!_.isString(value)) {
        return false;
    }
    return (
        [
            'A',
            'AAAA',
            'CNAME',
            'CAA',
            'MX',
            'TXT',
            'PTR',
            'SPF',
            'SRV',
            'NAPTR',
        ].indexOf(value) !== -1
    );
}

// CAA(name,tag,value, recordModifiers...)
var CAA = recordBuilder('CAA', {
    // TODO(tlim): It should be an error if value is not 0 or 128.
    args: [
        ['name', _.isString],
        ['tag', _.isString],
        ['value', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.caatag = args.tag;
        record.target = args.value;
    },
    modifierNumber: function(record, value) {
        record.caaflags |= value;
    },
});

// CNAME(name,target, recordModifiers...)
var CNAME = recordBuilder('CNAME');

// DS(name, keytag, algorithm, digestype, digest)
var DS = recordBuilder("DS", {
    args: [
        ['name', _.isString],
        ['keytag', _.isNumber],
        ['algorithm', _.isNumber],
        ['digesttype', _.isNumber],
        ['digest', _.isString]
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.dskeytag = args.keytag;
        record.dsalgorithm = args.algorithm;
        record.dsdigesttype = args.digesttype;
        record.dsdigest = args.digest;
        record.target = args.target;
    },
});

// PTR(name,target, recordModifiers...)
var PTR = recordBuilder('PTR');

// NAPTR(name,order,preference,flags,service,regexp,target, recordModifiers...)
var NAPTR = recordBuilder('NAPTR', {
    args: [
        ['name', _.isString],
        ['order', _.isNumber],
        ['preference', _.isNumber],
        ['flags', _.isString],
        ['service', _.isString],
        ['regexp', _.isString],
        ['target', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.naptrorder = args.order;
        record.naptrpreference = args.preference;
        record.naptrflags = args.flags;
        record.naptrservice = args.service;
        record.naptrregexp = args.regexp;
        record.target = args.target;
    },
});

// SOA(name,ns,mbox,refresh,retry,expire,minimum, recordModifiers...)
var SOA = recordBuilder('SOA', {
  args: [
    ['name',    _.isString],
    ['target',  _.isString],
    ['mbox',    _.isString],
    ['refresh', _.isNumber],
    ['retry',   _.isNumber],
    ['expire',  _.isNumber],
    ['minttl',  _.isNumber],
  ],
  transform: function(record, args, modifiers) {
    record.name = args.name;
    record.target = args.target;
    record.soambox = args.mbox;
    record.soarefresh = args.refresh;
    record.soaretry   = args.retry;
    record.soaexpire  = args.expire;
    record.soaminttl = args.minttl;
  },
});

// SRV(name,priority,weight,port,target, recordModifiers...)
var SRV = recordBuilder('SRV', {
    args: [
        ['name', _.isString],
        ['priority', _.isNumber],
        ['weight', _.isNumber],
        ['port', _.isNumber],
        ['target', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.srvpriority = args.priority;
        record.srvweight = args.weight;
        record.srvport = args.port;
        record.target = args.target;
    },
});

// SSHFP(name,algorithm,type,value, recordModifiers...)
var SSHFP = recordBuilder('SSHFP', {
    args: [
        ['name', _.isString],
        ['algorithm', _.isNumber],
        ['fingerprint', _.isNumber],
        ['value', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.sshfpalgorithm = args.algorithm;
        record.sshfpfingerprint = args.fingerprint;
        record.target = args.value;
    },
});

// name, usage, selector, matchingtype, certificate
var TLSA = recordBuilder('TLSA', {
    args: [
        ['name', _.isString],
        ['usage', _.isNumber],
        ['selector', _.isNumber],
        ['matchingtype', _.isNumber],
        ['target', _.isString], // recordBuilder needs a "target" argument
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.tlsausage = args.usage;
        record.tlsaselector = args.selector;
        record.tlsamatchingtype = args.matchingtype;
        record.target = args.target;
    },
});

function isStringOrArray(x) {
    return _.isString(x) || _.isArray(x);
}


// AUTOSPLIT is deprecated. It is now a no-op.
var AUTOSPLIT = { };

// TXT(name,target, recordModifiers...)
var TXT = recordBuilder('TXT', {
    args: [
        ['name', _.isString],
        ['target', isStringOrArray],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        // Store the strings from the user verbatim.
        if (_.isString(args.target)) {
            record.txtstrings = [args.target];
            record.target = args.target; // Overwritten by the Go code
        } else {
            record.txtstrings = args.target;
            record.target = args.target.join(""); // Overwritten by the Go code
        }
    },
});

// MX(name,priority,target, recordModifiers...)
var MX = recordBuilder('MX', {
    args: [
        ['name', _.isString],
        ['priority', _.isNumber],
        ['target', _.isString],
    ],
    transform: function(record, args, modifiers) {
        record.name = args.name;
        record.mxpreference = args.priority;
        record.target = args.target;
    },
});

// NS(name,target, recordModifiers...)
var NS = recordBuilder('NS');

// NAMESERVER(name,target)
function NAMESERVER(name) {
    if (arguments.length != 1) {
        throw 'NAMESERVER only accepts one argument for name.';
    }
    return function(d) {
        d.nameservers.push({ name: name });
    };
}

// NAMESERVER_TTL(v): Set the TTL for NAMESERVER records.
function NAMESERVER_TTL(v) {
    if (_.isString(v)) {
        v = stringToDuration(v);
    }
    return { ns_ttl: v.toString() };
}

function format_tt(transform_table) {
    // Turn [[low: 1, high: 2, newBase: 3], [low: 4, high: 5, newIP: 6]]
    // into "1 ~ 2 ~ 3 ~; 4 ~ 5 ~  ~ 6"
    var lines = [];
    for (var i = 0; i < transform_table.length; i++) {
        var ip = transform_table[i];
        var newIP = ip.newIP;
        if (newIP) {
            if (_.isArray(newIP)) {
                newIP = _.map(newIP, function(i) {
                    return num2dot(i);
                }).join(',');
            } else {
                newIP = num2dot(newIP);
            }
        }
        var newBase = ip.newBase;
        if (newBase) {
            if (_.isArray(newBase)) {
                newBase = _.map(newBase, function(i) {
                    return num2dot(i);
                }).join(',');
            } else {
                newBase = num2dot(newBase);
            }
        }
        var row = [num2dot(ip.low), num2dot(ip.high), newBase, newIP];
        lines.push(row.join(' ~ '));
    }
    return lines.join(' ; ');
}

// IGNORE(name)
function IGNORE(name) {
    // deprecated, use IGNORE_NAME
    return IGNORE_NAME(name);
}

// IGNORE_NAME(name)
function IGNORE_NAME(name) {
    return function(d) {
        d.ignored_names.push(name);
    };
}

var IGNORE_NAME_DISABLE_SAFETY_CHECK = {
  ignore_name_disable_safety_check: "true"
  // This disables a safety check intended to prevent:
  // 1. Two owners toggling a record between two settings.
  // 2. The other owner wiping all records at this label, which won't
  // be noticed until the next time dnscontrol is run.
  // See https://github.com/StackExchange/dnscontrol/issues/1106
};

// IGNORE_TARGET(target)
function IGNORE_TARGET(target, rType) {
    return function(d) {
        d.ignored_targets.push({pattern: target, type: rType});
    };
}


// IMPORT_TRANSFORM(translation_table, domain)
var IMPORT_TRANSFORM = recordBuilder('IMPORT_TRANSFORM', {
    args: [['translation_table'], ['domain'], ['ttl', _.isNumber]],
    transform: function(record, args, modifiers) {
        record.name = '@';
        record.target = args.domain;
        record.meta['transform_table'] = format_tt(args.translation_table);
        record.ttl = args.ttl;
    },
});

// PURGE()
function PURGE(d) {
    d.KeepUnknown = false;
}

// NO_PURGE()
function NO_PURGE(d) {
    d.KeepUnknown = true;
}

// AUTODNSSEC
// Permitted values are:
// ""  Do not modify the setting (the default)
// "on"   Enable AUTODNSSEC for this domain
// "off"  Disable AUTODNSSEC for this domain
function AUTODNSSEC_ON(d) {
  d.auto_dnssec = "on";
}
function AUTODNSSEC_OFF(d) {
  d.auto_dnssec = "off";
}
function AUTODNSSEC(d) {
  console.log(
    "WARNING: AUTODNSSEC is deprecated. It is now a no-op.  Please use AUTODNSSEC_ON or AUTODNSSEC_OFF. The default is to make no modifications. This message will disappear in a future release."
  );
}

/**
 * @deprecated
 */
function getModifiers(args, start) {
    var mods = [];
    for (var i = start; i < args.length; i++) {
        mods.push(args[i]);
    }
    return mods;
}

/**
 * Record type builder
 * @param {string} type Record type
 * @param {string} opts.args[][0] Argument name
 * @param {function=} opts.args[][1] Optional validator
 * @param {function=} opts.transform Function to apply arguments to record.
 *        Take (record, args, modifier) as arguments. Any modifiers will be
 *        applied before this function. It should mutate the given record.
 * @param {function=} opts.applyModifier Function to apply modifiers to the record
 */
function recordBuilder(type, opts) {
    opts = _.defaults({}, opts, {
        args: [['name', _.isString], ['target']],

        transform: function(record, args, modifiers) {
            // record will have modifiers already applied
            // args will be an object for parameters defined
            record.name = args.name;
            if (_.isNumber(args.target)) {
                record.target = num2dot(args.target);
            } else {
                record.target = args.target;
            }
        },

        applyModifier: function(record, modifiers) {
            for (var i = 0; i < modifiers.length; i++) {
                var mod = modifiers[i];

                if (_.isFunction(mod)) {
                    mod(record);
                } else if (_.isObject(mod)) {
                    // convert transforms to strings
                    if (mod.transform && _.isArray(mod.transform)) {
                        mod.transform = format_tt(mod.transform);
                    }
                    _.extend(record.meta, mod);
                } else {
                    throw 'ERROR: Unknown modifier type';
                }
            }
        },
    });

    return function() {
        var parsedArgs = {};
        var modifiers = [];

        if (arguments.length < opts.args.length) {
            var argumentsList = opts.args
                .map(function(item) {
                    return item[0];
                })
                .join(', ');
            throw type +
                ' record requires ' +
                opts.args.length +
                ' arguments (' +
                argumentsList +
                '). Only ' +
                arguments.length +
                ' were supplied';
            return;
        }

        // collect arguments
        for (var i = 0; i < opts.args.length; i++) {
            var argDefinition = opts.args[i];
            var value = arguments[i];
            if (argDefinition.length > 1) {
                // run validator if supplied
                if (!argDefinition[1](value)) {
                    throw type +
                        ' record ' +
                        argDefinition[0] +
                        ' argument validation failed';
                }
            }
            parsedArgs[argDefinition[0]] = value;
        }

        // collect modifiers
        for (var i = opts.args.length; i < arguments.length; i++) {
            modifiers.push(arguments[i]);
        }

        return function(d) {
            var record = {
                type: type,
                meta: {},
                ttl: d.defaultTTL,
            };

            opts.applyModifier(record, modifiers);
            opts.transform(record, parsedArgs, modifiers);

            // Handle D_EXTEND() with subdomains.
            if (d.subdomain &&
                record.type != 'CF_REDIRECT' &&
                record.type != 'CF_TEMP_REDIRECT' &&
                record.type != 'CF_WORKER_ROUTE') {
                fqdn = [d.subdomain, d.name].join(".")

                record.subdomain = d.subdomain;
                if (record.name == '@') {
                    record.subdomain = d.subdomain;
                    record.name = d.subdomain;
                } else if (fqdn != record.name && record.type != 'PTR') {
                    record.subdomain = d.subdomain;
                    record.name += '.' + d.subdomain;
                }
            }

            d.records.push(record);
            return record;
        };
    };
}

/**
 * @deprecated
 */
function addRecord(d, type, name, target, mods) {
    // if target is number, assume ip address. convert it.
    if (_.isNumber(target)) {
        target = num2dot(target);
    }
    var rec = {
        type: type,
        name: name,
        target: target,
        ttl: d.defaultTTL,
        priority: 0,
        meta: {},
    };
    // for each modifier, decide based on type:
    // - Function: call is with the record as the argument
    // - Object: merge it into the metadata
    // - Number: IF MX record assume it is priority
    if (mods) {
        for (var i = 0; i < mods.length; i++) {
            var m = mods[i];
            if (_.isFunction(m)) {
                m(rec);
            } else if (_.isObject(m)) {
                // convert transforms to strings
                if (m.transform && _.isArray(m.transform)) {
                    m.transform = format_tt(m.transform);
                }
                _.extend(rec.meta, m);
                _.extend(rec.meta, m);
            } else {
                console.log(
                    'WARNING: Modifier type unsupported:',
                    typeof m,
                    '(Skipping!)'
                );
            }
        }
    }
    d.records.push(rec);
    return rec;
}

// ip conversion functions from http://stackoverflow.com/a/8105740/121660
// via http://javascript.about.com/library/blipconvert.htm
function IP(dot) {
    var d = dot.split('.');
    // prettier-ignore
    return ((((((+d[0]) * 256) + (+d[1])) * 256) + (+d[2])) * 256) + (+d[3]);
}

function num2dot(num) {
    if (num === undefined) {
        return '';
    }
    if (_.isString(num)) {
        return num;
    }
    var d = num % 256;
    for (var i = 3; i > 0; i--) {
        num = Math.floor(num / 256);
        d = (num % 256) + '.' + d;
    }
    return d;
}

// Cloudflare aliases:

// Meta settings for individual records.
var CF_PROXY_OFF = { cloudflare_proxy: 'off' }; // Proxy disabled.
var CF_PROXY_ON = { cloudflare_proxy: 'on' }; // Proxy enabled.
var CF_PROXY_FULL = { cloudflare_proxy: 'full' }; // Proxy+Railgun enabled.
// Per-domain meta settings:
// Proxy default off for entire domain (the default):
var CF_PROXY_DEFAULT_OFF = { cloudflare_proxy_default: 'off' };
// Proxy default on for entire domain:
var CF_PROXY_DEFAULT_ON = { cloudflare_proxy_default: 'on' };
// UniversalSSL off for entire domain:
var CF_UNIVERSALSSL_OFF = { cloudflare_universalssl: 'off' };
// UniversalSSL on for entire domain:
var CF_UNIVERSALSSL_ON = { cloudflare_universalssl: 'on' };

// CUSTOM, PROVIDER SPECIFIC RECORD TYPES

function _validateCloudflareRedirect(value) {
    if (!_.isString(value)) {
        return false;
    }
    return value.indexOf(',') === -1;
}

var CF_REDIRECT = recordBuilder('CF_REDIRECT', {
    args: [
        ['source', _validateCloudflareRedirect],
        ['destination', _validateCloudflareRedirect],
    ],
    transform: function(record, args, modifiers) {
        record.name = '@';
        record.target = args.source + ',' + args.destination;
    },
});

var CF_TEMP_REDIRECT = recordBuilder('CF_TEMP_REDIRECT', {
    args: [
        ['source', _validateCloudflareRedirect],
        ['destination', _validateCloudflareRedirect],
    ],
    transform: function(record, args, modifiers) {
        record.name = '@';
        record.target = args.source + ',' + args.destination;
    },
});

var CF_WORKER_ROUTE = recordBuilder('CF_WORKER_ROUTE', {
    args: [
        ['pattern', _validateCloudflareRedirect],
        ['script', _validateCloudflareRedirect],
    ],
    transform: function(record, args, modifiers) {
        record.name = '@';
        record.target = args.pattern + ',' + args.script;
    },
});


var URL = recordBuilder('URL');
var URL301 = recordBuilder('URL301');
var FRAME = recordBuilder('FRAME');
var NS1_URLFWD = recordBuilder('NS1_URLFWD');

// SPF_BUILDER takes an object:
// parts: The parts of the SPF record (to be joined with ' ').
// label: The DNS label for the primary SPF record. (default: '@')
// raw: Where (which label) to store an unaltered version of the SPF settings.
// ttl: The time for TTL, integer or string. (default: not defined, using DefaultTTL)
// split: The template for additional records to be created (default: '_spf%d')
// flatten: A list of domains to be flattened.
// overhead1: Amout of "buffer room" to reserve on the first item in the spf chain.
// txtMaxSize: The maximum size for each TXT string. Values over 255 will result in multiple strings (default: '255')

function SPF_BUILDER(value) {
    if (!value.parts || value.parts.length < 2) {
        throw 'SPF_BUILDER requires at least 2 elements';
    }
    if (!value.label) {
        value.label = '@';
    }
    if (!value.raw && value.raw !== '') {
        value.raw = '_rawspf';
    }

    r = []; // The list of records to return.
    p = {}; // The metaparameters to set on the main TXT record.
    rawspf = value.parts.join(' '); // The unaltered SPF settings.

    // If flattening is requested, generate a TXT record with the raw SPF settings.
    if (value.flatten && value.flatten.length > 0) {
        p.flatten = value.flatten.join(',');
        // Only add the raw spf record if it isn't an empty string
        if (value.raw !== '') {
            rp = {};
            if (value.ttl) {
                r.push(TXT(value.raw, rawspf, rp, TTL(value.ttl)));
            } else {
                r.push(TXT(value.raw, rawspf, rp));
            }
        }
    }

    // If overflow is specified, enable splitting.
    if (value.overflow) {
        p.split = value.overflow;
    }

    if (value.overhead1) {
        p.overhead1 = value.overhead1;
    }

    if (value.txtMaxSize) {
        p.txtMaxSize = value.txtMaxSize;
    }

    // Generate a TXT record with the metaparameters.
    if (value.ttl) {
        r.push(TXT(value.label, rawspf, p, TTL(value.ttl)));
    } else {
        r.push(TXT(value.label, rawspf, p));
    }

    return r;
}

// CAA_BUILDER takes an object:
// label: The DNS label for the CAA record. (default: '@')
// iodef: The contact mail address. (optional)
// iodef_critical: Boolean if sending report is required/critical. If not supported, certificate should be refused. (optional)
// issue: List of CAs which are allowed to issue certificates for the domain (creates one record for each).
// issuewild: Allowed CAs which can issue wildcard certificates for this domain. (creates one record for each)

function CAA_BUILDER(value) {
    if (!value.label) {
        value.label = '@';
    }

    if (value.issue && value.issue == 'none') value.issue = [';'];
    if (value.issuewild && value.issuewild == 'none') value.issuewild = [';'];

    if (
        (!value.issue && !value.issuewild) ||
        (value.issue &&
            value.issue.length == 0 &&
            value.issuewild &&
            value.issuewild.length == 0)
    ) {
        throw 'CAA_BUILDER requires at least one entry at issue or issuewild';
    }

    r = []; // The list of records to return.

    if (value.iodef) {
        if (value.iodef_critical) {
            r.push(CAA(value.label, 'iodef', value.iodef, CAA_CRITICAL));
        } else {
            r.push(CAA(value.label, 'iodef', value.iodef));
        }
    }

    if (value.issue)
        for (var i = 0, len = value.issue.length; i < len; i++)
            r.push(CAA(value.label, 'issue', value.issue[i]));

    if (value.issuewild)
        for (var i = 0, len = value.issuewild.length; i < len; i++)
            r.push(CAA(value.label, 'issuewild', value.issuewild[i]));

    return r;
}

// DMARC_BUILDER takes an object:
// label: The DNS label for the DMARC record (_dmarc prefix is added; default: '@')
// version: The DMARC version, by default DMARC1 (optional)
// policy: The DMARC policy (p=), must be one of 'none', 'quarantine', 'reject'
// subdomainPolicy: The DMARC policy for subdomains (sp=), must be one of 'none', 'quarantine', 'reject' (optional)
// alignmentSPF: 'strict'/'s' or 'relaxed'/'r' alignment for SPF (aspf=, default: 'r')
// alignmentDKIM: 'strict'/'s' or 'relaxed'/'r' alignment for DKIM (adkim=, default: 'r')
// percent: Number between 0 and 100, percentage for which policies are applied (pct=, default: 100)
// rua: Array of aggregate report targets (optional)
// ruf: Array of failure report targets (optional)
// failureOptions: Object or string; Object containing booleans SPF and DKIM, string is passed raw (fo=, default: '0')
// failureFormat: Format in which failure reports are requested (rf=, default: 'afrf')
// reportInterval: Interval in which reports are requested (ri=)
// ttl: Input for TTL method
function DMARC_BUILDER(value) {
    if (!value) {
        value = {};
    }
    if (!value.label) {
        value.label = '@';
    }

    if (!value.version) {
        value.version = 'DMARC1';
    }

    var label = '_dmarc';
    if (value.label !== '@') {
        label += '.' + value.label;
    }

    if (!value.policy) {
        value.policy = 'none';
    }

    if (!value.policy === 'none' || !value.policy === 'quarantine' || !value.policy === 'reject') {
        throw 'Invalid DMARC policy';
    }

    var record = [];
    record.push('v=' + value.version);
    record.push('p=' + value.policy);

    // Subdomain policy
    if (!value.subdomainPolicy === 'none' || !value.subdomainPolicy === 'quarantine' || !value.subdomainPolicy === 'reject') {
        throw 'Invalid DMARC subdomain policy';
    }
    if (value.subdomainPolicy) {
        record.push('sp=' + value.subdomainPolicy);
    }

    // Alignment DKIM
    if (value.alignmentDKIM) {
        switch (value.alignmentDKIM) {
            case 'relaxed':
                value.alignmentDKIM = 'r';
                break;
            case 'strict':
                value.alignmentDKIM = 's';
                break;
            case 'r':
            case 's':
                break;
            default:
                throw 'Invalid DMARC DKIM alignment policy';
        }
        record.push('adkim=' + value.alignmentDKIM);
    }

    // Alignment SPF
    if (value.alignmentSPF) {
        switch (value.alignmentSPF) {
            case 'relaxed':
                value.alignmentSPF = 'r';
                break;
            case 'strict':
                value.alignmentSPF = 's';
                break;
            case 'r':
            case 's':
                break;
            default:
                throw 'Invalid DMARC DKIM alignment policy';
        }
        record.push('aspf=' + value.alignmentSPF);
    }

    // Percentage
    if (value.percent) {
        record.push('pct=' + value.percent);
    }

    // Aggregate reports
    if (value.rua && value.rua.length > 0) {
        record.push('rua=' + value.rua.join(','));
    }

    // Failure reports
    if (value.ruf && value.ruf.length > 0) {
        record.push('ruf=' + value.ruf.join(','));
    }

    // Failure reporting options
    if (value.ruf && value.failureOptions) {
        var fo = '0';
        if (_.isObject(value.failureOptions)) {
            if (value.failureOptions.DKIM) {
                fo = 'd';
            }
            if (value.failureOptions.SPF) {
                fo = 's';
            }
            if (value.failureOptions.DKIM && value.failureOptions.SPF) {
                fo = '1';
            }
        } else {
            fo = value.failureOptions;
        }

        if (fo !== '0') {
            record.push('fo=' + fo);
        }
    }

    // Failure report format
    if (value.ruf && value.failureFormat) {
        record.push('rf=' + value.failureFormat);
    }

    // Report interval
    if (value.reportInterval) {
        if (_.isString(value.reportInterval)) {
            value.reportInterval = stringToDuration(value.reportInterval);
        }

        record.push('ri=' + value.reportInterval);
    }

    if (value.ttl) {
        return TXT(label, record.join('; '), TTL(value.ttl));
    }
    return TXT(label, record.join('; '));
}

// This is a no-op.  Long TXT records are handled natively now.
function DKIM(arr) {
    return arr;
}

// Function wrapper for glob() for recursively loading files.
// As the main function (in Go) is in our control anyway, all the values here are already sanity-checked.
// Note: glob() is only an internal undocumented helper function. So use it on your own risk.
function require_glob() {
    arguments[2] = "js"; // force to only include .js files.
    var files = glob.apply(null, arguments);
    for (i = 0; i < files.length; i++) {
        require(files[i]);
    }
    return files
}

// Set default values for CLI variables
function CLI_DEFAULTS(defaults) {
    for (var key in defaults) {
        if (typeof this[key] === "undefined") {
            this[key] = defaults[key]
        }
    }
}

function FETCH() {
    return fetch.apply(null, arguments).catch(PANIC);
}

// DOMAIN_ELSEWHERE is a helper macro that delegates a domain to a
// static list of nameservers.  It updates the registrar (the parent)
// with a list of nameservers.  This is used when we own the domain (we
// control the registrar) but something else controls the DNS records
// (often a third-party of Azure).
// Usage: DOMAIN_ELSEWHERE("example.com", REG_NAMEDOTCOM, ["ns1.foo.com", "ns2.foo.com"]);
function DOMAIN_ELSEWHERE(domain, registrar, nslist) {
    D(domain, registrar, NO_PURGE);
    // NB(tlim): NO_PURGE is added as a precaution since something else
    // is maintaining the DNS records in that zone.  In theory this is
    // not needed since this domain won't have a DSP defined.
    for (i = 0; i < nslist.length; i++) {
        D_EXTEND(domain, NAMESERVER(nslist[i]));
    }
}

// DOMAIN_ELSEWHERE_AUTO is similar to DOMAIN_ELSEWHERE but the list of
// nameservers is queried from a DNS Service Provider.
// Usage: DOMAIN_ELSEWHERE_AUTO("example.com", REG_NAMEDOTCOM, DNS_FOO)
function DOMAIN_ELSEWHERE_AUTO(domain, registrar, dsplist) {
    D(domain, registrar, NO_PURGE);
    // NB(tlim): NO_PURGE is required since something else
    // is maintaining the DNS records in that zone, and we have access
    // to updating it (but we don't want to use it.)
    for (i = 2; i < arguments.length; i++) {
        D_EXTEND(domain, DnsProvider(arguments[i]));
    }
}
