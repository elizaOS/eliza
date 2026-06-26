import path from "node:path";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: "@elizaos/ui/agent-surface",
        replacement: path.resolve(
          __dirname,
          "../../packages/ui/src/agent-surface/index.ts",
        ),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    root: __dirname,
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "jsdom",
  },
});
