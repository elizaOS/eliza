// Browser stub for the Node built-ins (`node:fs`, `node:fs/promises`,
// `node:path`, `node:url`, `node:os`) that leak into the catalog through the
// `@elizaos/shared` barrel and `@elizaos/ui` services (package-root resolution,
// local-inference disk-space probing, etc.). The catalog never invokes those
// code paths, but Vite's dev server externalizes `node:*` to a proxy that
// throws on the named-import binding — so we supply non-throwing stubs. The
// pure path/url helpers do real string work; the fs helpers throw only if
// actually called (which the catalog never does).

// ── node:url ──────────────────────────────────────────────────────────────
export function fileURLToPath(input: string | URL): string {
  const href = typeof input === "string" ? input : input.href;
  return href.replace(/^file:\/\//, "");
}
export function pathToFileURL(p: string): URL {
  return new URL(`file://${p.startsWith("/") ? "" : "/"}${p}`);
}

// ── node:path ───────────────────────────────────────────────────────────────
export const sep = "/";
export const join = (...parts: string[]): string =>
  parts.join("/").replace(/\/+/g, "/") || ".";
export const resolve = (...parts: string[]): string => join("/", ...parts);
export const dirname = (p: string): string => p.replace(/\/[^/]*$/, "") || "/";
export const basename = (p: string): string => p.replace(/^.*\//, "");
export const extname = (p: string): string => {
  const m = /\.[^./]+$/.exec(basename(p));
  return m ? m[0] : "";
};

// ── node:os ───────────────────────────────────────────────────────────────
export const tmpdir = (): string => "/tmp";

// ── node:fs ─────────────────────────────────────────────────────────────────
const unavailable = (): never => {
  throw new Error("node:fs is not available in the browser catalog");
};
export const existsSync = (): boolean => false;
export const readdirSync = (): string[] => [];
export const readFileSync = unavailable;
export const writeFileSync = unavailable;
export const mkdirSync = unavailable;
export const mkdtempSync = (): string => "/tmp/catalog";
export const rmSync = (): void => undefined;
export const statfsSync = (): never => unavailable();

const asyncUnavailable = async (): Promise<never> => unavailable();
export const promises = {
  readFile: asyncUnavailable,
  writeFile: asyncUnavailable,
  mkdir: asyncUnavailable,
  readdir: asyncUnavailable,
  stat: asyncUnavailable,
};
// node:fs/promises named exports.
export const mkdir = asyncUnavailable;
export const writeFile = asyncUnavailable;

export default {
  fileURLToPath,
  pathToFileURL,
  sep,
  join,
  resolve,
  dirname,
  basename,
  extname,
  tmpdir,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  promises,
  mkdir,
  writeFile,
};
