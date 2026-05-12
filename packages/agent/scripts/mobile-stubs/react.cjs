// react.cjs — used by the mobile bundle to satisfy `import * as React`
// chains that survive in transitive dependencies even though the agent
// runtime never renders any UI on-device.
//
// Some workspace plugins (for example `@elizaos/app-lifeops`) re-export
// React component subtrees from their `src/index.ts` for the host app
// to consume. The agent only loads the runtime plugin object, but
// Bun.build still has to resolve every import in the dependency closure.
// Without a stub, Bun follows tsconfig path aliases that map `react` to
// `@types/react/index.d.ts`, then dies parsing TypeScript-only syntax
// (`export as namespace React`).
//
// The stub exposes a Proxy-backed namespace so `React.useState`,
// `React.createElement`, and friends evaluate to no-op functions when
// touched. Nothing at runtime should call them — the mobile bundle never
// executes JSX — so this is a strictly-typed safety net.
"use strict";

const NOOP_FN = function noopReactStub() {
  return undefined;
};

const FRAGMENT = Symbol("React.Fragment");

function makeReactProxy() {
  const target = function reactStub() {
    return undefined;
  };
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === "default") return module.exports;
      if (prop === "__esModule") return true;
      if (prop === "Fragment") return FRAGMENT;
      if (prop === "createElement") return NOOP_FN;
      if (prop === "createContext") {
        return () => ({
          Provider: NOOP_FN,
          Consumer: NOOP_FN,
          displayName: undefined,
        });
      }
      if (prop === "memo" || prop === "forwardRef" || prop === "lazy") {
        return (component) => component;
      }
      if (prop === "useState") return (initial) => [initial, NOOP_FN];
      if (prop === "useReducer") return (_r, initial) => [initial, NOOP_FN];
      if (prop === "useRef") return (initial) => ({ current: initial });
      if (prop === "useMemo") return (factory) => factory();
      if (prop === "useCallback") return (cb) => cb;
      if (prop === "useEffect" || prop === "useLayoutEffect") return NOOP_FN;
      if (prop === "useContext") return () => undefined;
      if (prop === "useImperativeHandle") return NOOP_FN;
      if (prop === "useId") return () => "";
      if (prop === "useTransition") return () => [false, NOOP_FN];
      if (prop === "useDeferredValue") return (v) => v;
      if (prop === "useSyncExternalStore") return (_s, _g, init) => init();
      if (prop === "useDebugValue") return NOOP_FN;
      if (prop === "Children") {
        return {
          map: NOOP_FN,
          forEach: NOOP_FN,
          count: () => 0,
          only: NOOP_FN,
          toArray: () => [],
        };
      }
      if (prop === "version") return "0.0.0-mobile-stub";
      if (prop === "StrictMode" || prop === "Suspense" || prop === "Profiler") {
        return FRAGMENT;
      }
      return NOOP_FN;
    },
    has() {
      return true;
    },
  });
}

module.exports = makeReactProxy();
