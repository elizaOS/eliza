// Stub for `node:module` in the Storybook browser catalog. `createRequire` is
// called at module load by core modules pulled via the @elizaos/shared barrel
// (`const require = createRequire(import.meta.url)`); return a require-like that
// throws only if actually invoked, with a `.resolve` that does the same.
const notAvailable = (name: string) => {
  throw new Error(`node:module stub cannot ${name} in Storybook`);
};

export const createRequire = () => {
  const req = (() => notAvailable("require")) as ((id: string) => unknown) & {
    resolve: (id: string) => string;
    cache: Record<string, unknown>;
  };
  req.resolve = () => notAvailable("require.resolve") as never;
  req.cache = {};
  return req;
};

export const builtinModules: string[] = [];
export const isBuiltin = () => false;
export const createRequireFromPath = createRequire;

export default {
  createRequire,
  createRequireFromPath,
  builtinModules,
  isBuiltin,
};
