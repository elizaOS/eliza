// Browser-safe `global` for both `import "global"` and bare-identifier cases.
// The early inline script in index.html installs the actual safe shadow on
// `globalThis.global`. We prefer that; falling back to a minimal proxy if the
// script hasn't run yet (e.g. during some test or SSR paths).
// The shadow swallows writes to Window readonly properties such as `close`.

type ProcessShim = {
  env: Record<string, string | undefined>;
  browser: boolean;
  nextTick: (fn: () => void) => void;
};

type SafeGlobal = Omit<typeof globalThis, "process"> & {
  process?: ProcessShim;
};

type GlobalThisWithShadow = typeof globalThis & { global?: SafeGlobal };

const getSafeGlobal = (): SafeGlobal => {
  try {
    if (typeof globalThis !== "undefined") {
      const shadow = (globalThis as GlobalThisWithShadow).global;
      if (shadow && shadow !== globalThis) {
        return shadow;
      }
    }
  } catch (_) {}

  // Fallback minimal shadow (same logic as the early script, in case this
  // module is evaluated extremely early). Native DOM globals (navigator,
  // location, crypto, name, self, ...) are accessor properties on
  // Window.prototype: reading one through this derived shadow invokes the
  // getter with the wrong receiver and throws "Illegal invocation". Re-install
  // every inherited accessor as a pass-through to globalThis so reads resolve;
  // writes are swallowed so they never touch the read-only DOM globals.
  const base = typeof globalThis !== "undefined" ? globalThis : {};
  const g = Object.create(base) as SafeGlobal;
  for (
    let obj: object | null = base;
    obj && obj !== Object.prototype;
    obj = Object.getPrototypeOf(obj)
  ) {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (Object.hasOwn(g, key)) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || typeof desc.get !== "function") {
        continue;
      }
      try {
        Object.defineProperty(g, key, {
          configurable: true,
          enumerable: false,
          get: () => (globalThis as Record<string, unknown>)?.[key],
          set: () => {
            /* ignore */
          },
        });
      } catch (_) {}
    }
  }
  if (!g.process) {
    g.process = {
      env: {},
      browser: true,
      nextTick: (fn: () => void) =>
        typeof queueMicrotask === "function"
          ? queueMicrotask(fn)
          : Promise.resolve().then(fn),
    };
  }
  return g;
};

const safeGlobal = getSafeGlobal();
export default safeGlobal;
