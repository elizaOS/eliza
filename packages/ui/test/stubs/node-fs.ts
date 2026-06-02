// Browser stub for `node:fs` + `node:fs/promises`, used only by the Storybook
// catalog. The local-inference services (reachable from the state graph that
// useApp()-dependent components import) import these and call e.g. `fs.cp(...)`
// or destructure sync helpers. In a browser build Vite externalizes those
// builtins to a stub that THROWS on access, breaking any story that imports the
// state graph. These services never run in the catalog — we only need the
// imports to resolve, so every member is a no-op.
const member = (): undefined => undefined;

// Default import (`import fs from "node:fs/promises"; fs.cp(...)`) — any member
// is a no-op via the Proxy.
const proxy: Record<string, unknown> = new Proxy(
  { constants: {} },
  { get: (_target, prop) => (prop === "constants" ? {} : member) },
);
export default proxy;

export const constants = {};

// node:fs/promises members.
export const cp = member;
export const readFile = member;
export const writeFile = member;
export const appendFile = member;
export const mkdir = member;
export const rm = member;
export const rmdir = member;
export const unlink = member;
export const rename = member;
export const copyFile = member;
export const stat = member;
export const lstat = member;
export const readdir = member;
export const realpath = member;
export const readlink = member;
export const symlink = member;
export const open = member;
export const access = member;
export const chmod = member;
export const utimes = member;
export const mkdtemp = member;

// node:fs sync + misc members.
export const existsSync = member;
export const readFileSync = member;
export const writeFileSync = member;
export const appendFileSync = member;
export const mkdirSync = member;
export const rmSync = member;
export const rmdirSync = member;
export const unlinkSync = member;
export const renameSync = member;
export const copyFileSync = member;
export const cpSync = member;
export const statSync = member;
export const lstatSync = member;
export const readdirSync = member;
export const realpathSync = member;
export const readlinkSync = member;
export const symlinkSync = member;
export const openSync = member;
export const closeSync = member;
export const readSync = member;
export const writeSync = member;
export const accessSync = member;
export const chmodSync = member;
export const utimesSync = member;
export const watch = member;
export const watchFile = member;
export const unwatchFile = member;
export const createReadStream = member;
export const createWriteStream = member;
