// Shim for `node:os` in the Storybook browser catalog. Vite externalizes node
// builtins for the browser, so any access (e.g. `os.homedir()` at module scope
// in @elizaos/core/utils/state-dir) throws "externalized for browser
// compatibility". The core path helpers genuinely call these to derive a state
// dir, so the shim returns benign browser values rather than throwing —
// the derived paths are unused in the renderer.

export const homedir = () => "/home/storybook";
export const tmpdir = () => "/tmp";
export const hostname = () => "storybook";
export const platform = () => "browser";
export const arch = () => "x64";
export const type = () => "Browser";
export const release = () => "";
export const cpus = () => [];
export const totalmem = () => 0;
export const freemem = () => 0;
export const uptime = () => 0;
export const loadavg = () => [0, 0, 0];
export const networkInterfaces = () => ({});
export const userInfo = () => ({
  username: "storybook",
  uid: -1,
  gid: -1,
  shell: null,
  homedir: "/home/storybook",
});
export const endianness = () => "LE";
export const EOL = "\n";
export const constants = {};

export default {
  EOL,
  arch,
  constants,
  cpus,
  endianness,
  freemem,
  homedir,
  hostname,
  loadavg,
  networkInterfaces,
  platform,
  release,
  tmpdir,
  totalmem,
  type,
  uptime,
  userInfo,
};
