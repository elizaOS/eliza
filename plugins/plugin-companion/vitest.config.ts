import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

const liveOnlyExcludes = [
  "dist/**",
  "**/node_modules/**",
  "**/*.live.test.{ts,tsx}",
  "**/*.live.e2e.test.{ts,tsx}",
  "**/*.real.test.{ts,tsx}",
  "**/*.real.e2e.test.{ts,tsx}",
  "**/*.integration.test.{ts,tsx}",
  "**/*.e2e.test.{ts,tsx}",
];

export default defineConfig({
  ...baseConfig,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(repoRoot, "packages/ui/src/index.ts"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: liveOnlyExcludes,
  },
});
