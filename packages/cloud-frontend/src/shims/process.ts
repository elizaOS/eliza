// Minimal browser-side `process` shim. The Vite `define` map already replaces
// `process.env.<KEY>` literal accesses for the whitelisted public env keys at
// build time, so this only needs to cover whole-object access patterns:
// `process.nextTick(...)`, `process.browser`, `process.versions.node`, etc.
// Returning a real object here keeps libraries that read these values during
// module init from throwing.

const stub = {
  env: {} as Record<string, string | undefined>,
  browser: true,
  version: "",
  versions: { node: "0.0.0" },
  platform: "browser" as const,
  nextTick: (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    queueMicrotask(() => fn(...args)),
};

export default stub;
export const env = stub.env;
export const nextTick = stub.nextTick;
export const browser = true;
export const version = "";
export const versions = stub.versions;
export const platform = "browser";
