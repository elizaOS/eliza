// Browser-safe shim for the `inherits` npm package.
//
// The upstream `inherits.js` main entry tries `require('util').inherits`
// first and falls back to `inherits_browser.js` inside a try/catch. Vite
// aliases `util` to an empty shim, so the real path is the fallback —
// but rolldown's optimizeDeps prebundle has trouble wiring that fallback
// through the wrapped CommonJS module. Result: at runtime
// `require_inherits_browser` is undefined and elliptic / hash-base /
// create-hash crash, taking the React tree down with them on /login.
//
// Body of `inherits_browser.js` exposed as a single CJS module so vite
// resolves to a known-good entry every time. Drops the legacy
// `Object.create`-less branch — every browser the SPA targets has it.

module.exports = function inherits(ctor, superCtor) {
  if (superCtor) {
    ctor.super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true,
      },
    });
  }
};
