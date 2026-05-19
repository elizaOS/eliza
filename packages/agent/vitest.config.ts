import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../packages/test/vitest/default.config";

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
        find: "@elizaos/app-core",
        replacement: path.join(monorepoRoot, "packages/app-core/src/index.ts"),
      },
      {
        find: "@elizaos/ui",
        replacement: path.join(monorepoRoot, "packages/ui/src/index.ts"),
      },
      ...baseAliases,
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(monorepoRoot, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(monorepoRoot, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/tui/src/$1"),
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
      {
        find: /^react$/,
        replacement: path.join(repoRoot, "node_modules/react"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(repoRoot, "node_modules/react/jsx-runtime.js"),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(repoRoot, "node_modules/react-dom"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(repoRoot, "node_modules/react-dom/client.js"),
      },
    ],
  },
  test: {
    ...baseConfig.test,
    environment: "node",
    pool: "vmForks",
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
