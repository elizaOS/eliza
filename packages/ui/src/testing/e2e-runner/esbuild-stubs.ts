/**
 * esbuild resolve/load plugins the `__e2e__` fixture runners share to bundle a
 * shell fixture for the browser. The overlay's import graph transitively reaches
 * server-only code — `@elizaos/core` module-init that touches `process` + node
 * builtins — which is dead at render in a headless page. Production Vite
 * resolves core's `browser` export condition; a raw esbuild bundle does not, so
 * these plugins replace those edges with no-op proxies.
 *
 * Type-only esbuild import: importing these factories pulls no runtime esbuild, so
 * the frame-glitch harness (which resolves esbuild itself) can share them too.
 */

import { builtinModules } from "node:module";
import type { Plugin } from "esbuild";

/**
 * Replace `@elizaos/core` with a no-op Proxy that answers the render-path symbols
 * the shell reads (`isViewVisible`, `dedupeModalities`, `findInteractionRegions`)
 * and proxies everything else, so core's Node graph is never bundled.
 */
export function stubElizaCore(): Plugin {
  return {
    name: "stub-eliza-core",
    setup(build) {
      build.onResolve({ filter: /^@elizaos\/core$/ }, (args) => ({
        path: args.path,
        namespace: "eliza-core-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "eliza-core-stub" }, () => ({
        contents: `
        const noop = new Proxy(() => noop, { get: () => noop });
        module.exports = new Proxy(
          {
            isViewVisible: () => true,
            dedupeModalities: (m) => Array.from(new Set(Array.isArray(m) ? m : [])),
            findInteractionRegions: () => [],
          },
          { get: (t, p) => (p in t ? t[p] : noop) },
        );
      `,
        loader: "js",
      }));
    },
  };
}

/** Replace every node builtin (dead in the browser) with a no-op proxy module. */
export function stubNodeBuiltins(): Plugin {
  const nodeBuiltins = new Set([
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ]);
  return {
    name: "stub-node-builtins",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const bare = args.path.replace(/^node:/, "").split("/")[0] ?? "";
        if (
          args.path.startsWith("node:") ||
          nodeBuiltins.has(args.path) ||
          builtinModules.includes(bare)
        ) {
          return { path: args.path, namespace: "node-stub" };
        }
        return null;
      });
      build.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
        contents: `function anyfn() { return anyfn; }
export default anyfn;
export const createRequire = () => anyfn;
export const homedir = anyfn;
export const tmpdir = anyfn;
export const platform = anyfn;
export const isAbsolute = anyfn;
export const join = anyfn;
export const resolve = anyfn;
export const dirname = anyfn;
export const basename = anyfn;
export const extname = anyfn;
export const sep = "/";
export const createHash = () => ({ update: () => ({ digest: () => "" }) });
export const randomBytes = anyfn;
export const randomUUID = () => "00000000-0000-0000-0000-000000000000";
export const Buffer = {
  from: () => ({}),
  isBuffer: () => false,
  alloc: () => ({}),
  byteLength: () => 0,
};
export const promises = {};
export const existsSync = () => false;
export const readFileSync = anyfn;
export const writeFileSync = anyfn;
export const mkdirSync = anyfn;
export const readdirSync = () => [];
export const statSync = anyfn;
export const realpathSync = anyfn;
export const renameSync = anyfn;
export const unlinkSync = anyfn;
export const EventEmitter = class {};
export const fileURLToPath = anyfn;
export const pathToFileURL = anyfn;
export const lookup = anyfn;
export const request = anyfn;
export const createHmac = () => ({ update: () => ({ digest: () => "" }) });
export const timingSafeEqual = () => false;
export const createCipheriv = anyfn;
export const createDecipheriv = anyfn;
export const pbkdf2Sync = anyfn;
export const scryptSync = anyfn;
export const execFile = anyfn;
export const exec = anyfn;
export const promisify = () => anyfn;
export const readFile = anyfn;
export const readlink = anyfn;
export const rename = anyfn;
export const rm = anyfn;
export const symlink = anyfn;
export const unlink = anyfn;
export const writeFile = anyfn;
export const mkdir = anyfn;
export const stat = anyfn;
export const readdir = () => [];
export const isIP = () => 0;
export const statfsSync = anyfn;
export const cp = anyfn;
export class AsyncLocalStorage {
  run(_store, fn, ...args) {
    return fn(...args);
  }
  getStore() {
    return undefined;
  }
}`,
        loader: "js",
      }));
    },
  };
}
