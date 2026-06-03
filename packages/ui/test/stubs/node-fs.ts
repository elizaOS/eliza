const notAvailable = (name: string) => {
  throw new Error(`node:fs stub cannot ${name} in Storybook`);
};

export const constants = {};

export const existsSync = () => false;
export const statSync = () => notAvailable("statSync");
export const readFileSync = () => notAvailable("readFileSync");
export const writeFileSync = () => notAvailable("writeFileSync");
export const mkdirSync = () => notAvailable("mkdirSync");
export const rmSync = () => notAvailable("rmSync");
export const readdirSync = () => notAvailable("readdirSync");
export const unlinkSync = () => notAvailable("unlinkSync");

export const access = async () => notAvailable("access");
export const readFile = async () => notAvailable("readFile");
export const writeFile = async () => notAvailable("writeFile");
export const mkdir = async () => notAvailable("mkdir");
export const rm = async () => notAvailable("rm");
export const readdir = async () => [];
export const stat = async () => notAvailable("stat");
export const unlink = async () => notAvailable("unlink");

export default {
  access,
  constants,
  existsSync,
  mkdir,
  mkdirSync,
  readFile,
  readFileSync,
  readdir,
  readdirSync,
  rm,
  rmSync,
  stat,
  statSync,
  unlink,
  unlinkSync,
  writeFile,
  writeFileSync,
};
