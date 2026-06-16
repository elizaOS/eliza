// Browser shim for `fs-extra`, which is only pulled into cloud-frontend through
// server-only @elizaos/core services. Static bundling still has to evaluate the
// import graph, but the dashboard must never execute filesystem operations.
const notAvailable = (name: string | symbol) => {
  throw new Error(`fs-extra browser shim cannot ${String(name)} in cloud UI`);
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
