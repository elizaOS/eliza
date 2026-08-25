/**
 * Browser shim for the Node built-ins (`node:fs`, `node:fs/promises`,
 * `node:path`, `node:url`, `node:os`) that leak into the catalog through the
 * `@elizaos/shared` barrel and `@elizaos/ui` services (package-root resolution,
 * local-inference disk-space probing, etc.). The catalog never invokes those
 * code paths, but Vite's dev server externalizes `node:*` to a proxy that
 * throws on the named-import binding, so this supplies non-throwing shims. The
 * pure path/url helpers do real string work; the fs helpers throw only if
 * actually called (which the catalog never does).
 */

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

// ── node:net ────────────────────────────────────────────────────────────────
// The @elizaos/shared loopback-trust / sandbox / host-capability guards call
// net.isIP at module load. The catalog never validates real addresses, so a
// lightweight literal check is enough (0 = not an IP, matching node's contract).
export const isIP = (input: string): 0 | 4 | 6 => {
  if (typeof input !== "string") return 0;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(input)) return 4;
  if (input.includes(":") && /^[0-9a-fA-F:.]+$/.test(input)) return 6;
  return 0;
};
export const isIPv4 = (input: string): boolean => isIP(input) === 4;
export const isIPv6 = (input: string): boolean => isIP(input) === 6;
export class BlockList {
  readonly #addresses = new Set<string>();

  addAddress(address: string, _type?: string): void {
    this.#addresses.add(address.toLowerCase());
  }

  addSubnet(address: string, prefix: number, _type?: string): void {
    const family = isIP(address);
    if ((family === 4 && prefix === 32) || (family === 6 && prefix === 128)) {
      this.addAddress(address);
    }
  }

  addRange(start: string, end: string): void {
    this.addAddress(start);
    this.addAddress(end);
  }

  check(address: string, _type?: string): boolean {
    return this.#addresses.has(address.toLowerCase());
  }
}

// ── node:crypto (named bits some guards touch at load) ───────────────────────
export const randomUUID = (): string => "00000000-0000-4000-8000-000000000000";

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
