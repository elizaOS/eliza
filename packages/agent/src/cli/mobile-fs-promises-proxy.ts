import * as realPromises from "node:fs/promises";
import { fileURLToPath } from "node:url";

type FsAccessMode = "read" | "write";
type AnyFn = (...args: unknown[]) => unknown;
type MobileFsGlobals = typeof globalThis & {
  __ELIZA_MOBILE_FS_RESOLVE__?: (
    inputPath: string,
    mode?: FsAccessMode,
  ) => string;
};

function requireResolver(): NonNullable<
  MobileFsGlobals["__ELIZA_MOBILE_FS_RESOLVE__"]
> {
  const resolver = (globalThis as MobileFsGlobals).__ELIZA_MOBILE_FS_RESOLVE__;
  if (!resolver) {
    throw new Error(
      "mobile-fs-promises-proxy: filesystem access before installMobileFsShim()",
    );
  }
  return resolver;
}

function pathLikeToString(raw: unknown): string | null {
  if (raw instanceof URL) {
    if (raw.protocol !== "file:") {
      throw new Error(
        `mobile-fs-promises-proxy: only file: URLs are accepted (${raw.protocol})`,
      );
    }
    return fileURLToPath(raw);
  }
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return typeof raw === "string" ? raw : null;
}

function modeForOpenFlags(flags: unknown): FsAccessMode {
  if (typeof flags !== "string" || flags.length === 0) return "read";
  return /[wa+]/.test(flags) ? "write" : "read";
}

function wrapPath<T extends AnyFn>(fn: T | undefined, mode: FsAccessMode): T {
  return function wrappedFsPath(this: unknown, ...args: unknown[]) {
    const pathStr = pathLikeToString(args[0]);
    if (pathStr !== null) {
      args[0] = requireResolver()(pathStr, mode);
    }
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}

function wrapOpen<T extends AnyFn>(fn: T | undefined): T {
  return function wrappedFsOpen(this: unknown, ...args: unknown[]) {
    const pathStr = pathLikeToString(args[0]);
    if (pathStr !== null) {
      args[0] = requireResolver()(pathStr, modeForOpenFlags(args[1]));
    }
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}

function wrapTwoPaths<T extends AnyFn>(
  fn: T | undefined,
  srcMode: FsAccessMode,
  dstMode: FsAccessMode,
): T {
  return function wrappedFsTwoPaths(this: unknown, ...args: unknown[]) {
    const src = pathLikeToString(args[0]);
    const dst = pathLikeToString(args[1]);
    const resolver = requireResolver();
    if (src !== null) args[0] = resolver(src, srcMode);
    if (dst !== null) args[1] = resolver(dst, dstMode);
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}

export const access = wrapPath(realPromises.access, "read");
export const appendFile = wrapPath(realPromises.appendFile, "write");
export const chmod = wrapPath(realPromises.chmod, "write");
export const chown = wrapPath(realPromises.chown, "write");
export const copyFile = wrapTwoPaths(realPromises.copyFile, "read", "write");
export const cp = wrapTwoPaths(realPromises.cp, "read", "write");
export const lchmod = wrapPath(realPromises.lchmod, "write");
export const lchown = wrapPath(realPromises.lchown, "write");
export const link = wrapTwoPaths(realPromises.link, "read", "write");
export const lstat = wrapPath(realPromises.lstat, "read");
export const lutimes = wrapPath(realPromises.lutimes, "write");
export const mkdir = wrapPath(realPromises.mkdir, "write");
export const mkdtemp = wrapPath(realPromises.mkdtemp, "write");
export const open = wrapOpen(realPromises.open);
export const opendir = wrapPath(realPromises.opendir, "read");
export const readdir = wrapPath(realPromises.readdir, "read");
export const readFile = wrapPath(realPromises.readFile, "read");
export const readlink = wrapPath(realPromises.readlink, "read");
export const realpath = wrapPath(realPromises.realpath, "read");
export const rename = wrapTwoPaths(realPromises.rename, "write", "write");
export const rm = wrapPath(realPromises.rm, "write");
export const rmdir = wrapPath(realPromises.rmdir, "write");
export const stat = wrapPath(realPromises.stat, "read");
export const symlink = wrapTwoPaths(realPromises.symlink, "read", "write");
export const truncate = wrapPath(realPromises.truncate, "write");
export const unlink = wrapPath(realPromises.unlink, "write");
export const utimes = wrapPath(realPromises.utimes, "write");
export const watch = wrapPath(realPromises.watch, "read");
export const writeFile = wrapPath(realPromises.writeFile, "write");

const promisesDefault = {
  ...realPromises,
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  cp,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
};

export default promisesDefault;
