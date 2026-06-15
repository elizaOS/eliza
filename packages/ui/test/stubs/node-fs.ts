// AUTO-COMPLETE node:fs / node:fs/promises shim for the Storybook browser
// catalog. Both specifiers alias here (see .storybook/main.ts). The browser
// never reaches a real fs call — these exist only so static ESM named imports
// from deps reached by the @elizaos/* graph resolve. Calls throw (surfacing
// genuine misuse) except harmless probes (existsSync->false, readdir->[]).

const notAvailable = (name: string) => {
  throw new Error(`node:fs browser shim cannot ${name} in Storybook`);
};

export const constants = {};

export class Dir {}
export class Dirent {}
export class FileReadStream {}
export class FileWriteStream {}
export class ReadStream {}
export class Stats {}
export class WriteStream {}

// node:fs (sync + callback)
export const _toUnixTimestamp = (..._args: unknown[]) =>
  notAvailable("_toUnixTimestamp");
export const access = (..._args: unknown[]) => notAvailable("access");
export const accessSync = (..._args: unknown[]) => notAvailable("accessSync");
export const appendFile = (..._args: unknown[]) => notAvailable("appendFile");
export const appendFileSync = (..._args: unknown[]) =>
  notAvailable("appendFileSync");
export const chmod = (..._args: unknown[]) => notAvailable("chmod");
export const chmodSync = (..._args: unknown[]) => notAvailable("chmodSync");
export const chown = (..._args: unknown[]) => notAvailable("chown");
export const chownSync = (..._args: unknown[]) => notAvailable("chownSync");
export const close = (..._args: unknown[]) => notAvailable("close");
export const closeSync = (..._args: unknown[]) => notAvailable("closeSync");
export const copyFile = (..._args: unknown[]) => notAvailable("copyFile");
export const copyFileSync = (..._args: unknown[]) =>
  notAvailable("copyFileSync");
export const cp = (..._args: unknown[]) => notAvailable("cp");
export const cpSync = (..._args: unknown[]) => notAvailable("cpSync");
export const createReadStream = (..._args: unknown[]) =>
  notAvailable("createReadStream");
export const createWriteStream = (..._args: unknown[]) =>
  notAvailable("createWriteStream");
export const exists = () => false;
export const existsSync = () => false;
export const fchmod = (..._args: unknown[]) => notAvailable("fchmod");
export const fchmodSync = (..._args: unknown[]) => notAvailable("fchmodSync");
export const fchown = (..._args: unknown[]) => notAvailable("fchown");
export const fchownSync = (..._args: unknown[]) => notAvailable("fchownSync");
export const fdatasync = (..._args: unknown[]) => notAvailable("fdatasync");
export const fdatasyncSync = (..._args: unknown[]) =>
  notAvailable("fdatasyncSync");
export const fstat = (..._args: unknown[]) => notAvailable("fstat");
export const fstatSync = (..._args: unknown[]) => notAvailable("fstatSync");
export const fsync = (..._args: unknown[]) => notAvailable("fsync");
export const fsyncSync = (..._args: unknown[]) => notAvailable("fsyncSync");
export const ftruncate = (..._args: unknown[]) => notAvailable("ftruncate");
export const ftruncateSync = (..._args: unknown[]) =>
  notAvailable("ftruncateSync");
export const futimes = (..._args: unknown[]) => notAvailable("futimes");
export const futimesSync = (..._args: unknown[]) => notAvailable("futimesSync");
export const glob = (..._args: unknown[]) => notAvailable("glob");
export const globSync = (..._args: unknown[]) => notAvailable("globSync");
export const lchmod = (..._args: unknown[]) => notAvailable("lchmod");
export const lchmodSync = (..._args: unknown[]) => notAvailable("lchmodSync");
export const lchown = (..._args: unknown[]) => notAvailable("lchown");
export const lchownSync = (..._args: unknown[]) => notAvailable("lchownSync");
export const link = (..._args: unknown[]) => notAvailable("link");
export const linkSync = (..._args: unknown[]) => notAvailable("linkSync");
export const lstat = (..._args: unknown[]) => notAvailable("lstat");
export const lstatSync = (..._args: unknown[]) => notAvailable("lstatSync");
export const lutimes = (..._args: unknown[]) => notAvailable("lutimes");
export const lutimesSync = (..._args: unknown[]) => notAvailable("lutimesSync");
export const mkdir = (..._args: unknown[]) => notAvailable("mkdir");
export const mkdirSync = (..._args: unknown[]) => notAvailable("mkdirSync");
export const mkdtemp = (..._args: unknown[]) => notAvailable("mkdtemp");
export const mkdtempDisposableSync = (..._args: unknown[]) =>
  notAvailable("mkdtempDisposableSync");
export const mkdtempSync = (..._args: unknown[]) => notAvailable("mkdtempSync");
export const open = (..._args: unknown[]) => notAvailable("open");
export const openAsBlob = (..._args: unknown[]) => notAvailable("openAsBlob");
export const openSync = (..._args: unknown[]) => notAvailable("openSync");
export const opendir = (..._args: unknown[]) => notAvailable("opendir");
export const opendirSync = (..._args: unknown[]) => notAvailable("opendirSync");
export const read = (..._args: unknown[]) => notAvailable("read");
export const readFile = (..._args: unknown[]) => notAvailable("readFile");
export const readFileSync = (..._args: unknown[]) =>
  notAvailable("readFileSync");
export const readSync = (..._args: unknown[]) => notAvailable("readSync");
export const readdir = () => [];
export const readdirSync = () => [];
export const readlink = (..._args: unknown[]) => notAvailable("readlink");
export const readlinkSync = (..._args: unknown[]) =>
  notAvailable("readlinkSync");
export const readv = (..._args: unknown[]) => notAvailable("readv");
export const readvSync = (..._args: unknown[]) => notAvailable("readvSync");
export const realpath = (..._args: unknown[]) => notAvailable("realpath");
export const realpathSync = (..._args: unknown[]) =>
  notAvailable("realpathSync");
export const rename = (..._args: unknown[]) => notAvailable("rename");
export const renameSync = (..._args: unknown[]) => notAvailable("renameSync");
export const rm = (..._args: unknown[]) => notAvailable("rm");
export const rmSync = (..._args: unknown[]) => notAvailable("rmSync");
export const rmdir = (..._args: unknown[]) => notAvailable("rmdir");
export const rmdirSync = (..._args: unknown[]) => notAvailable("rmdirSync");
export const stat = (..._args: unknown[]) => notAvailable("stat");
export const statSync = (..._args: unknown[]) => notAvailable("statSync");
export const statfs = (..._args: unknown[]) => notAvailable("statfs");
export const statfsSync = (..._args: unknown[]) => notAvailable("statfsSync");
export const symlink = (..._args: unknown[]) => notAvailable("symlink");
export const symlinkSync = (..._args: unknown[]) => notAvailable("symlinkSync");
export const truncate = (..._args: unknown[]) => notAvailable("truncate");
export const truncateSync = (..._args: unknown[]) =>
  notAvailable("truncateSync");
export const unlink = (..._args: unknown[]) => notAvailable("unlink");
export const unlinkSync = (..._args: unknown[]) => notAvailable("unlinkSync");
export const unwatchFile = (..._args: unknown[]) => notAvailable("unwatchFile");
export const utimes = (..._args: unknown[]) => notAvailable("utimes");
export const utimesSync = (..._args: unknown[]) => notAvailable("utimesSync");
export const watch = (..._args: unknown[]) => notAvailable("watch");
export const watchFile = (..._args: unknown[]) => notAvailable("watchFile");
export const write = (..._args: unknown[]) => notAvailable("write");
export const writeFile = (..._args: unknown[]) => notAvailable("writeFile");
export const writeFileSync = (..._args: unknown[]) =>
  notAvailable("writeFileSync");
export const writeSync = (..._args: unknown[]) => notAvailable("writeSync");
export const writev = (..._args: unknown[]) => notAvailable("writev");
export const writevSync = (..._args: unknown[]) => notAvailable("writevSync");

// node:fs/promises
export const mkdtempDisposable = async (..._args: unknown[]) =>
  notAvailable("mkdtempDisposable");

export const promises = {
  access,
  appendFile,
  chmod,
  chown,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
};

export default {
  Dir,
  Dirent,
  FileReadStream,
  FileWriteStream,
  ReadStream,
  Stats,
  WriteStream,
  _toUnixTimestamp,
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  close,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  glob,
  globSync,
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
  mkdtempDisposable,
  mkdtempDisposableSync,
  mkdtempSync,
  open,
  openAsBlob,
  openSync,
  opendir,
  opendirSync,
  promises,
  read,
  readFile,
  readFileSync,
  readSync,
  readdir,
  readdirSync,
  readlink,
  readlinkSync,
  readv,
  readvSync,
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
  statfs,
  statfsSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  unwatchFile,
  utimes,
  utimesSync,
  watch,
  watchFile,
  write,
  writeFile,
  writeFileSync,
  writeSync,
  writev,
  writevSync,
};
