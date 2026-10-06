/** Vitest configuration for the Network spike plugin (mirrors plugin-todos). */
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

export default defineConfig({
  resolve: {
    ...baseConfig.resolve,
    conditions: ["node"],
    alias: baseAliases,
  },
  ssr: { resolve: { conditions: ["node"] } },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 60_000,
    pool: "forks",
    server: { deps: { inline: ["@elizaos/core"] } },
  },
});
