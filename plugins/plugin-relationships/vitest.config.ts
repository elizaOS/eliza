/**
 * Vitest configuration for relationships domain contract tests with shared
 * workspace aliases.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
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
        find: /^@elizaos\/plugin-wallet\/diagnostic$/,
        replacement: path.resolve(here, "../plugin-wallet/src/diagnostic.ts"),
      },
      ...baseAliases,
    ],
  },
  test: {
    ...baseConfig.test,
    root: here,
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: liveOnlyExcludes,
  },
});
