/** Real check-in collectors without unrelated app or LifeOps mock setup. */
import path from "node:path";
import { createPluginRealRuntimeConfig } from "../../packages/scripts/vitest/plugin-real-runtime.config.ts";

const config = createPluginRealRuntimeConfig();
config.root = import.meta.dirname;
config.test = {
  ...config.test,
  include: ["src/lifeops/checkin/checkin-availability.pglite.test.ts"],
  maxWorkers: 1,
};
const aliases = Array.isArray(config.resolve?.alias)
  ? config.resolve.alias
  : [];
config.resolve = {
  ...config.resolve,
  alias: [
    {
      find: "@elizaos/plugin-relationships",
      replacement: path.resolve(
        import.meta.dirname,
        "../plugin-relationships/src/index.node.ts",
      ),
    },
    ...aliases,
  ],
};
export default config;
