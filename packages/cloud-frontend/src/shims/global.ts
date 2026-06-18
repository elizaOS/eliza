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
  // module is evaluated extremely early).
  const g = Object.create(
    typeof globalThis !== "undefined" ? globalThis : {},
  ) as SafeGlobal;
  const readonlys = [
    "close",
    "open",
    "name",
    "status",
    "self",
    "top",
    "parent",
    "frames",
    "window",
    "document",
  ];
  for (const k of readonlys) {
    try {
      Object.defineProperty(g, k, {
        configurable: true,
        enumerable: false,
        get: () => (globalThis as Record<string, unknown>)?.[k],
        set: () => {
          /* ignore */
        },
      });
    } catch (_) {}
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
