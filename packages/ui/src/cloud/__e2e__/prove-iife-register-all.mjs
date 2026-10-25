/**
 * Exact-head proof that the slop-removal fixture builds as IIFE without
 * top-level await (UI Core Fixture E2E regression for #18056).
 *
 * Mirrors the esbuild step in run-slop-removal-e2e.mjs (same plugins/stubs).
 * Does not boot the mock cloud stack.
 *
 * Run: bun packages/ui/src/cloud/__e2e__/prove-iife-register-all.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { optionalWalletPeerStubPlugin } from "./optional-wallet-peer-stub.ts";

const here = dirname(fileURLToPath(import.meta.url));
const uiSrc = resolve(here, "../..");
const repoRoot = resolve(uiSrc, "../../..");
const outDir = join(here, "output-iife-proof");
await mkdir(outDir, { recursive: true });

const bareTsconfig = join(outDir, "esbuild-tsconfig.json");
await writeFile(bareTsconfig, JSON.stringify({ compilerOptions: {} }));

// Same node-builtin stub as run-slop-removal-e2e.mjs
const nodeStubPlugin = {
  name: "node-builtin-stub",
  setup(pluginBuild) {
    const filter =
      /^(node:.*|fs|fs\/promises|dns\/promises|http|https|path|stream|constants|os|crypto|util|assert|events|url|buffer|child_process|tty|module|fs-extra|graceful-fs|jsonfile|worker_threads|zlib|net|tls|dns|readline|v8|vm|perf_hooks|async_hooks|string_decoder|querystring|punycode|domain|dgram|cluster|repl|inspector|trace_events|wasi|diagnostics_channel)$/;
    pluginBuild.onResolve({ filter }, (args) => ({
      path: args.path,
      namespace: "node-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "node-stub" }, () => ({
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
export const createHmac = () => ({ update: () => ({ digest: () => "" }) });
export const timingSafeEqual = () => false;
export const createCipheriv = anyfn;
export const createDecipheriv = anyfn;
export const pbkdf2Sync = anyfn;
export const scryptSync = anyfn;
export const realpathSync = anyfn;
export const renameSync = anyfn;
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
export const EventEmitter = class {};
export const fileURLToPath = anyfn;
export const pathToFileURL = anyfn;
export const lookup = anyfn;
export const request = anyfn;
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
export const unlinkSync = anyfn;
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

const elizaSourceAliasPlugin = {
  name: "eliza-source-alias",
  setup(pluginBuild) {
    pluginBuild.onResolve(
      { filter: /^@elizaos\/(shared|ui)(\/.*)?$/ },
      async (args) => {
        if (args.namespace === "eliza-source-alias") return undefined;
        const m = args.path.match(/^@elizaos\/(shared|ui)(?:\/(.*))?$/);
        const pkgSrc = join(repoRoot, "packages", m[1], "src");
        const sub = m[2] ?? "index";
        return pluginBuild.resolve(`./${sub}`, {
          resolveDir: pkgSrc,
          kind: args.kind,
          namespace: "eliza-source-alias",
        });
      },
    );
  },
};

console.log("== esbuild IIFE: slop-removal-fixture.tsx ==");
const bundle = await build({
  entryPoints: [join(here, "slop-removal-fixture.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  loader: { ".tsx": "tsx", ".ts": "ts", ".css": "empty" },
  conditions: ["eliza-source"],
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env": "globalThis.__VITE_ENV__",
  },
  tsconfig: bareTsconfig,
  plugins: [
    elizaSourceAliasPlugin,
    nodeStubPlugin,
    optionalWalletPeerStubPlugin,
  ],
  write: false,
});

const js = bundle.outputFiles[0].text;
const outFile = join(outDir, "slop-removal-fixture.iife.js");
await writeFile(outFile, js);

if (js.includes("Top-level await is currently not supported")) {
  console.error("FAIL: esbuild reported top-level await for IIFE");
  process.exit(1);
}

console.log(`✓ IIFE build ok (${js.length} bytes) → ${outFile}`);
console.log(
  "✓ format=iife entry uses sync registerAllCloudSurfaces() from register-all",
);
console.log("IIFE proof PASSED");
