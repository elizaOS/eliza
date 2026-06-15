// Shim for `fs-extra` in the Storybook browser catalog. The package is reached
// only through node-only @elizaos/core services (plugin-manager,
// personality/character-file-manager) that never execute during a story
// render; it is imported as a default (`import fs from "fs-extra"`). fs-extra
// is CJS with no ESM default export, so under optimizeDeps.noDiscovery Vite
// can't synthesise one and the import crashes module evaluation. A
// default-exported Proxy satisfies the static default import; any method access
// throws if a code path ever actually calls it in the browser.
const notAvailable = (name: string | symbol) => {
  throw new Error(`fs-extra browser shim cannot ${String(name)} in Storybook`);
};

const stub = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === "default") return stub;
      return (..._args: unknown[]) => notAvailable(prop);
    },
  },
);

export default stub;
