// AUTO-COMPLETE node:fs / node:fs/promises stub for the Storybook browser
// catalog. Both specifiers alias here (see .storybook/main.ts). The browser
// never reaches a real fs call — these exist only so static ESM named imports
// from deps reached by the @elizaos/* graph resolve. Calls throw (surfacing
// genuine misuse) except harmless probes (existsSync->false, readdir->[]).

const notAvailable = (name: string) => {
  throw new Error(`node:fs stub cannot ${name} in Storybook`);
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
export const _toUnixTimestamp = (...args: unknown[]) =>
  notAvailable("_toUnixTimestamp");
export const access = (...args: unknown[]) => notAvailable("access");
export const accessSync = (...args: unknown[]) => notAvailable("accessSync");
export const appendFile = (...args: unknown[]) => notAvailable("appendFile");
export const appendFileSync = (...args: unknown[]) =>
  notAvailable("appendFileSync");
export const chmod = (...args: unknown[]) => notAvailable("chmod");
export const chmodSync = (...args: unknown[]) => notAvailable("chmodSync");
export const chown = (...args: unknown[]) => notAvailable("chown");
export const chownSync = (...args: unknown[]) => notAvailable("chownSync");
export const close = (...args: unknown[]) => notAvailable("close");
export const closeSync = (...args: unknown[]) => notAvailable("closeSync");
export const copyFile = (...args: unknown[]) => notAvailable("copyFile");
export const copyFileSync = (...args: unknown[]) =>
  notAvailable("copyFileSync");
export const cp = (...args: unknown[]) => notAvailable("cp");
export const cpSync = (...args: unknown[]) => notAvailable("cpSync");
export const createReadStream = (...args: unknown[]) =>
  notAvailable("createReadStream");
export const createWriteStream = (...args: unknown[]) =>
  notAvailable("createWriteStream");
export const exists = () => false;
export const existsSync = () => false;
export const fchmod = (...args: unknown[]) => notAvailable("fchmod");
export const fchmodSync = (...args: unknown[]) => notAvailable("fchmodSync");
export const fchown = (...args: unknown[]) => notAvailable("fchown");
export const fchownSync = (...args: unknown[]) => notAvailable("fchownSync");
export const fdatasync = (...args: unknown[]) => notAvailable("fdatasync");
export const fdatasyncSync = (...args: unknown[]) =>
  notAvailable("fdatasyncSync");
export const fstat = (...args: unknown[]) => notAvailable("fstat");
export const fstatSync = (...args: unknown[]) => notAvailable("fstatSync");
export const fsync = (...args: unknown[]) => notAvailable("fsync");
export const fsyncSync = (...args: unknown[]) => notAvailable("fsyncSync");
export const ftruncate = (...args: unknown[]) => notAvailable("ftruncate");
export const ftruncateSync = (...args: unknown[]) =>
  notAvailable("ftruncateSync");
export const futimes = (...args: unknown[]) => notAvailable("futimes");
export const futimesSync = (...args: unknown[]) => notAvailable("futimesSync");
export const glob = (...args: unknown[]) => notAvailable("glob");
export const globSync = (...args: unknown[]) => notAvailable("globSync");
export const lchmod = (...args: unknown[]) => notAvailable("lchmod");
export const lchmodSync = (...args: unknown[]) => notAvailable("lchmodSync");
export const lchown = (...args: unknown[]) => notAvailable("lchown");
export const lchownSync = (...args: unknown[]) => notAvailable("lchownSync");
export const link = (...args: unknown[]) => notAvailable("link");
export const linkSync = (...args: unknown[]) => notAvailable("linkSync");
export const lstat = (...args: unknown[]) => notAvailable("lstat");
export const lstatSync = (...args: unknown[]) => notAvailable("lstatSync");
export const lutimes = (...args: unknown[]) => notAvailable("lutimes");
export const lutimesSync = (...args: unknown[]) => notAvailable("lutimesSync");
export const mkdir = (...args: unknown[]) => notAvailable("mkdir");
export const mkdirSync = (...args: unknown[]) => notAvailable("mkdirSync");
export const mkdtemp = (...args: unknown[]) => notAvailable("mkdtemp");
export const mkdtempDisposableSync = (...args: unknown[]) =>
  notAvailable("mkdtempDisposableSync");
export const mkdtempSync = (...args: unknown[]) => notAvailable("mkdtempSync");
export const open = (...args: unknown[]) => notAvailable("open");
export const openAsBlob = (...args: unknown[]) => notAvailable("openAsBlob");
export const openSync = (...args: unknown[]) => notAvailable("openSync");
export const opendir = (...args: unknown[]) => notAvailable("opendir");
export const opendirSync = (...args: unknown[]) => notAvailable("opendirSync");
export const read = (...args: unknown[]) => notAvailable("read");
export const readFile = (...args: unknown[]) => notAvailable("readFile");
export const readFileSync = (...args: unknown[]) =>
  notAvailable("readFileSync");
export const readSync = (...args: unknown[]) => notAvailable("readSync");
export const readdir = () => [];
export const readdirSync = () => [];
export const readlink = (...args: unknown[]) => notAvailable("readlink");
export const readlinkSync = (...args: unknown[]) =>
  notAvailable("readlinkSync");
export const readv = (...args: unknown[]) => notAvailable("readv");
export const readvSync = (...args: unknown[]) => notAvailable("readvSync");
export const realpath = (...args: unknown[]) => notAvailable("realpath");
export const realpathSync = (...args: unknown[]) =>
  notAvailable("realpathSync");
export const rename = (...args: unknown[]) => notAvailable("rename");
export const renameSync = (...args: unknown[]) => notAvailable("renameSync");
export const rm = (...args: unknown[]) => notAvailable("rm");
export const rmSync = (...args: unknown[]) => notAvailable("rmSync");
export const rmdir = (...args: unknown[]) => notAvailable("rmdir");
export const rmdirSync = (...args: unknown[]) => notAvailable("rmdirSync");
export const stat = (...args: unknown[]) => notAvailable("stat");
export const statSync = (...args: unknown[]) => notAvailable("statSync");
export const statfs = (...args: unknown[]) => notAvailable("statfs");
export const statfsSync = (...args: unknown[]) => notAvailable("statfsSync");
export const symlink = (...args: unknown[]) => notAvailable("symlink");
export const symlinkSync = (...args: unknown[]) => notAvailable("symlinkSync");
export const truncate = (...args: unknown[]) => notAvailable("truncate");
export const truncateSync = (...args: unknown[]) =>
  notAvailable("truncateSync");
export const unlink = (...args: unknown[]) => notAvailable("unlink");
export const unlinkSync = (...args: unknown[]) => notAvailable("unlinkSync");
export const unwatchFile = (...args: unknown[]) => notAvailable("unwatchFile");
export const utimes = (...args: unknown[]) => notAvailable("utimes");
export const utimesSync = (...args: unknown[]) => notAvailable("utimesSync");
export const watch = (...args: unknown[]) => notAvailable("watch");
export const watchFile = (...args: unknown[]) => notAvailable("watchFile");
export const write = (...args: unknown[]) => notAvailable("write");
export const writeFile = (...args: unknown[]) => notAvailable("writeFile");
export const writeFileSync = (...args: unknown[]) =>
  notAvailable("writeFileSync");
export const writeSync = (...args: unknown[]) => notAvailable("writeSync");
export const writev = (...args: unknown[]) => notAvailable("writev");
export const writevSync = (...args: unknown[]) => notAvailable("writevSync");

// node:fs/promises
export const mkdtempDisposable = async (...args: unknown[]) =>
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
