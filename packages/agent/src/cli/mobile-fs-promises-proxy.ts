import * as realPromises from "node:fs/promises";
import type { AnyFn, FsAccessMode } from "./mobile-fs-sandbox.ts";
import {
  wrapMobileFsOpen,
  wrapMobileFsPath,
  wrapMobileFsTwoPaths,
} from "./mobile-fs-sandbox.ts";

const MODULE_NAME = "mobile-fs-promises-proxy";

function wrapPath<T extends AnyFn>(fn: T | undefined, mode: FsAccessMode): T {
  return wrapMobileFsPath(MODULE_NAME, fn, mode);
}

function wrapOpen<T extends AnyFn>(fn: T | undefined): T {
  return wrapMobileFsOpen(MODULE_NAME, fn);
}

function wrapTwoPaths<T extends AnyFn>(
  fn: T | undefined,
  srcMode: FsAccessMode,
  dstMode: FsAccessMode,
): T {
  return wrapMobileFsTwoPaths(MODULE_NAME, fn, srcMode, dstMode);
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
