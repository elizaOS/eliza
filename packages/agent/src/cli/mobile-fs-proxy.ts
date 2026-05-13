import * as realFs from "node:fs";
import { fileURLToPath } from "node:url";

import * as sandboxedPromises from "./mobile-fs-promises-proxy.ts";

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
      "mobile-fs-proxy: filesystem access before installMobileFsShim()",
    );
  }
  return resolver;
}

function pathLikeToString(raw: unknown): string | null {
  if (raw instanceof URL) {
    if (raw.protocol !== "file:") {
      throw new Error(
        `mobile-fs-proxy: only file: URLs are accepted (${raw.protocol})`,
      );
    }
    return fileURLToPath(raw);
  }
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return typeof raw === "string" ? raw : null;
}

function modeForOpenFlags(flags: unknown): FsAccessMode {
  if (typeof flags === "number") {
    const writeBits =
      realFs.constants.O_WRONLY |
      realFs.constants.O_RDWR |
      realFs.constants.O_APPEND |
      realFs.constants.O_CREAT |
      realFs.constants.O_TRUNC;
    return (flags & writeBits) !== 0 ? "write" : "read";
  }
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

export const constants = realFs.constants;
export const promises = sandboxedPromises;
export const access = wrapPath(realFs.access, "read");
export const accessSync = wrapPath(realFs.accessSync, "read");
export const appendFile = wrapPath(realFs.appendFile, "write");
export const appendFileSync = wrapPath(realFs.appendFileSync, "write");
export const chmod = wrapPath(realFs.chmod, "write");
export const chmodSync = wrapPath(realFs.chmodSync, "write");
export const chown = wrapPath(realFs.chown, "write");
export const chownSync = wrapPath(realFs.chownSync, "write");
export const close = realFs.close;
export const closeSync = realFs.closeSync;
export const copyFile = wrapTwoPaths(realFs.copyFile, "read", "write");
export const copyFileSync = wrapTwoPaths(realFs.copyFileSync, "read", "write");
export const cp = wrapTwoPaths(realFs.cp, "read", "write");
export const cpSync = wrapTwoPaths(realFs.cpSync, "read", "write");
export const createReadStream = wrapPath(realFs.createReadStream, "read");
export const createWriteStream = wrapPath(realFs.createWriteStream, "write");
export const existsSync = wrapPath(realFs.existsSync, "read");
export const fchmod = realFs.fchmod;
export const fchmodSync = realFs.fchmodSync;
export const fchown = realFs.fchown;
export const fchownSync = realFs.fchownSync;
export const fdatasync = realFs.fdatasync;
export const fdatasyncSync = realFs.fdatasyncSync;
export const fstat = realFs.fstat;
export const fstatSync = realFs.fstatSync;
export const fsync = realFs.fsync;
export const fsyncSync = realFs.fsyncSync;
export const ftruncate = realFs.ftruncate;
export const ftruncateSync = realFs.ftruncateSync;
export const futimes = realFs.futimes;
export const futimesSync = realFs.futimesSync;
export const lchmod = wrapPath(realFs.lchmod, "write");
export const lchmodSync = wrapPath(realFs.lchmodSync, "write");
export const lchown = wrapPath(realFs.lchown, "write");
export const lchownSync = wrapPath(realFs.lchownSync, "write");
export const link = wrapTwoPaths(realFs.link, "read", "write");
export const linkSync = wrapTwoPaths(realFs.linkSync, "read", "write");
export const lstat = wrapPath(realFs.lstat, "read");
export const lstatSync = wrapPath(realFs.lstatSync, "read");
export const lutimes = wrapPath(realFs.lutimes, "write");
export const lutimesSync = wrapPath(realFs.lutimesSync, "write");
export const mkdir = wrapPath(realFs.mkdir, "write");
export const mkdirSync = wrapPath(realFs.mkdirSync, "write");
export const mkdtemp = wrapPath(realFs.mkdtemp, "write");
export const mkdtempSync = wrapPath(realFs.mkdtempSync, "write");
export const open = wrapOpen(realFs.open);
export const openSync = wrapOpen(realFs.openSync);
export const opendir = wrapPath(realFs.opendir, "read");
export const opendirSync = wrapPath(realFs.opendirSync, "read");
export const readdir = wrapPath(realFs.readdir, "read");
export const readdirSync = wrapPath(realFs.readdirSync, "read");
export const read = realFs.read;
export const readFile = wrapPath(realFs.readFile, "read");
export const readFileSync = wrapPath(realFs.readFileSync, "read");
export const readSync = realFs.readSync;
export const readlink = wrapPath(realFs.readlink, "read");
export const readlinkSync = wrapPath(realFs.readlinkSync, "read");
export const realpath = wrapPath(realFs.realpath, "read");
export const realpathSync = wrapPath(realFs.realpathSync, "read");
export const rename = wrapTwoPaths(realFs.rename, "write", "write");
export const renameSync = wrapTwoPaths(realFs.renameSync, "write", "write");
export const rm = wrapPath(realFs.rm, "write");
export const rmSync = wrapPath(realFs.rmSync, "write");
export const rmdir = wrapPath(realFs.rmdir, "write");
export const rmdirSync = wrapPath(realFs.rmdirSync, "write");
export const stat = wrapPath(realFs.stat, "read");
export const statSync = wrapPath(realFs.statSync, "read");
export const symlink = wrapTwoPaths(realFs.symlink, "read", "write");
export const symlinkSync = wrapTwoPaths(realFs.symlinkSync, "read", "write");
export const truncate = wrapPath(realFs.truncate, "write");
export const truncateSync = wrapPath(realFs.truncateSync, "write");
export const unlink = wrapPath(realFs.unlink, "write");
export const unlinkSync = wrapPath(realFs.unlinkSync, "write");
export const unwatchFile = realFs.unwatchFile;
export const utimes = wrapPath(realFs.utimes, "write");
export const utimesSync = wrapPath(realFs.utimesSync, "write");
export const watch = wrapPath(realFs.watch, "read");
export const watchFile = wrapPath(realFs.watchFile, "read");
export const write = realFs.write;
export const writeFile = wrapPath(realFs.writeFile, "write");
export const writeFileSync = wrapPath(realFs.writeFileSync, "write");
export const writeSync = realFs.writeSync;

const fsDefault = {
  ...realFs,
  constants,
  promises,
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lchmod,
  lchmodSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempSync,
  open,
  openSync,
  opendir,
  opendirSync,
  readdir,
  readdirSync,
  readFile,
  readFileSync,
  readlink,
  readlinkSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  utimes,
  utimesSync,
  watch,
  watchFile,
  writeFile,
  writeFileSync,
};

export default fsDefault;
