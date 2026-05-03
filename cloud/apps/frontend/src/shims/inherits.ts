// Browser-safe shim for the `inherits` npm package.
//
// `inherits`'s main entry (`inherits.js`) tries `require('util').inherits`
// first and falls back to `inherits_browser.js` inside a try/catch. Vite
// aliases `util` to an empty shim, so the real path is the fallback — but
// rolldown / esbuild's optimizeDeps prebundle has trouble wiring the
// fallback through the wrapped CommonJS module. Result: at runtime,
// `require_inherits_browser` is undefined and elliptic / hash-base /
// create-hash crash, taking the React tree down with them on /login.
//
// Copy the body of `inherits_browser.js` directly so vite resolves to a
// known-good module. This is identical to what every browser-side bundler
// (webpack, esbuild's classic path, rollup's commonjs plugin) ends up
// using.

function inherits(ctor: Function, superCtor: Function) {
  if (superCtor) {
    (ctor as { super_?: Function }).super_ = superCtor;
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true,
      },
    });
  }
}

export default inherits;
export { inherits };
// CommonJS interop — `require('inherits')` returns the function directly.
// @ts-expect-error — module is a runtime-only commonjs shape.
module.exports = inherits;
// @ts-expect-error
module.exports.default = inherits;
// @ts-expect-error
module.exports.inherits = inherits;
