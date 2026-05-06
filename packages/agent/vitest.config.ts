import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const baseAliases = Array.isArray(baseConfig.resolve?.alias)
  ? baseConfig.resolve.alias
  : [];

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(packageRoot, "../..");
const srcRoot = path.join(packageRoot, "src");

export default defineConfig({
  ...baseConfig,
  root: here,
  resolve: {
    ...baseConfig.resolve,
    alias: [
      ...baseAliases,
      {
        find: /^@elizaos\/agent$/,
        replacement: path.join(srcRoot, "index.ts"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(srcRoot, "$1"),
      },
      {
        find: /^@elizaos\/app-core\/account-pool$/,
        replacement: path.join(
          monorepoRoot,
          "packages/app-core/src/account-pool.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-cli$/,
        replacement: path.join(
          repoRoot,
          "plugins",
          "plugin-cli",
          "typescript",
          "src",
          "index.ts",
        ),
      },
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: {
      deps: {
        inline: [/@elizaos\//],
      },
    },
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*-real.test.{ts,tsx}",
    ],
  },
});
