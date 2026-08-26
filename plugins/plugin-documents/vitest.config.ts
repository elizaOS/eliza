/** Vitest config for @elizaos/plugin-documents: extends the shared base config with the package's local aliases. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/scripts/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

// Live/real e2e suites need running services + env; the unit suite below covers
// the plugin's route, presenter, and service contracts. The base config supplies
// the @elizaos/* source aliases those tests need.
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
    alias: [...baseAliases],
  },
  test: {
    ...baseConfig.test,
    root: here,
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: liveOnlyExcludes,
  },
});
