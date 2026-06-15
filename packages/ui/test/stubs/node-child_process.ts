// Stub for `node:child_process` in the Storybook browser catalog. Subprocesses
// never spawn during a render; export the names the reachable chain imports so
// module init succeeds, throwing only if a call is actually made.
const notAvailable = (name: string) => {
  throw new Error(`node:child_process stub cannot ${name} in Storybook`);
};

export class ChildProcess {}
export const exec = () => notAvailable("exec");
export const execFile = () => notAvailable("execFile");
export const execSync = () => notAvailable("execSync");
export const execFileSync = () => notAvailable("execFileSync");
export const spawn = () => notAvailable("spawn");
export const spawnSync = () => notAvailable("spawnSync");
export const fork = () => notAvailable("fork");

export default {
  ChildProcess,
  exec,
  execFile,
  execSync,
  execFileSync,
  spawn,
  spawnSync,
  fork,
};
