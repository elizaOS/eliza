// Browser-safe `global` for both `import "global"` and bare-identifier cases.
// The early inline script in index.html installs the actual safe shadow on
// `globalThis.global`. We prefer that; falling back to a minimal proxy if the
// script hasn't run yet (e.g. during some test or SSR paths).
// The shadow swallows writes to Window readonly properties such as `close`.

const getSafeGlobal = (): any => {
  try {
    if (
      typeof globalThis !== "undefined" &&
      (globalThis as any).global &&
      (globalThis as any).global !== globalThis
    ) {
      return (globalThis as any).global;
    }
  } catch (_) {}

  // Fallback minimal shadow (same logic as the early script, in case this
  // module is evaluated extremely early).
  const g: any = Object.create(
    typeof globalThis !== "undefined" ? globalThis : {},
  );
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
        get: () => (globalThis as any)?.[k],
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
      nextTick: (fn: any) =>
        typeof queueMicrotask === "function"
          ? queueMicrotask(fn)
          : Promise.resolve().then(fn),
    };
  }
  return g;
};

const safeGlobal = getSafeGlobal();
export default safeGlobal;
