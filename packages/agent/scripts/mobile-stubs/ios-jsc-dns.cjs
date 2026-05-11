// node:dns stub for the iOS JSContext runtime.
//
// URLSession (used by the Swift Capacitor plugin's fetch implementation)
// handles DNS resolution internally, so the agent never needs to resolve
// hostnames itself. This stub returns the input hostname unresolved (as
// if it were already an IP) so any defensive code that calls dns.lookup
// keeps moving rather than crashing.
"use strict";

function lookup(hostname, optionsOrCb, maybeCb) {
  const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
  if (typeof cb === "function") {
    queueMicrotask(() => cb(null, hostname, 4));
    return;
  }
  return Promise.resolve({ address: hostname, family: 4 });
}

function resolve(hostname, _rrtype, cb) {
  const callback = typeof _rrtype === "function" ? _rrtype : cb;
  if (typeof callback === "function") {
    queueMicrotask(() => callback(null, [hostname]));
    return;
  }
  return Promise.resolve([hostname]);
}

const noopPromise = () => Promise.resolve([]);

const promises = {
  lookup: (hostname) => Promise.resolve({ address: hostname, family: 4 }),
  resolve: (hostname) => Promise.resolve([hostname]),
  resolve4: (hostname) => Promise.resolve([hostname]),
  resolve6: (hostname) => Promise.resolve([hostname]),
  resolveCname: noopPromise,
  resolveMx: noopPromise,
  resolveNs: noopPromise,
  resolveTxt: noopPromise,
  reverse: (ip) => Promise.resolve([ip]),
  Resolver: class Resolver {
    setServers() {}
    getServers() {
      return [];
    }
  },
};

module.exports = {
  __iosJscStub: true,
  lookup,
  resolve,
  resolve4: resolve,
  resolve6: resolve,
  resolveCname: (_h, cb) => (typeof cb === "function" ? cb(null, []) : Promise.resolve([])),
  resolveMx: (_h, cb) => (typeof cb === "function" ? cb(null, []) : Promise.resolve([])),
  resolveNs: (_h, cb) => (typeof cb === "function" ? cb(null, []) : Promise.resolve([])),
  resolveTxt: (_h, cb) => (typeof cb === "function" ? cb(null, []) : Promise.resolve([])),
  reverse: (ip, cb) => (typeof cb === "function" ? cb(null, [ip]) : Promise.resolve([ip])),
  promises,
  Resolver: promises.Resolver,
  ADDRCONFIG: 32,
  V4MAPPED: 8,
  ALL: 16,
};

module.exports.default = module.exports;
