// react-dom.cjs — mobile bundle stub matching ./react.cjs.
// The agent runtime never renders DOM on-device; transitive imports
// (e.g. from `@elizaos/app-lifeops` UI re-exports) get this no-op shim.
"use strict";

const NOOP_FN = function noopReactDomStub() {
  return undefined;
};

function makeReactDomProxy() {
  const target = function reactDomStub() {
    return undefined;
  };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "default") return module.exports;
      if (prop === "__esModule") return true;
      if (prop === "createPortal") return NOOP_FN;
      if (prop === "flushSync") return (cb) => (typeof cb === "function" ? cb() : undefined);
      if (prop === "version") return "0.0.0-mobile-stub";
      if (prop === "render" || prop === "hydrate" || prop === "unmountComponentAtNode") {
        return NOOP_FN;
      }
      return NOOP_FN;
    },
    has() {
      return true;
    },
  });
}

module.exports = makeReactDomProxy();
