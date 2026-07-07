/** Configures the deterministic Vitest harness for packages/agent tests. */
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
        find: /^@elizaos\/app-core\/ui-compat$/,
        replacement: path.join(
          monorepoRoot,
          "packages/app-core/src/ui-compat.ts",
        ),
      },
      {
        find: "@elizaos/app-core",
        replacement: path.join(monorepoRoot, "packages/app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(monorepoRoot, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/ui/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(monorepoRoot, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(monorepoRoot, "packages/tui/src/$1"),
      },
      // Explicitly pin react/react-dom to the workspace copies in the bun-managed
      // flat hoisted structure. Without this, bun's module resolver can walk up
      // to parent directories and pick up a different react version (e.g., a
      // react@19.2.6 from ~/.../milaidy/node_modules when the workspace has
      // react@19.2.5), which breaks the React hook dispatcher interface.
      // These MUST come before ...baseAliases because the base config's
      // resolveInstalledPackageRoot("react") walks up to the parent repo and
      // picks up react@19.2.6, producing a wrong alias that would otherwise win.
      {
        find: /^react$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react/index.js",
        ),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react-dom/index.js",
        ),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(
          repoRoot,
          "node_modules/.bun/node_modules/react-dom/client.js",
        ),
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
        find: /^@elizaos\/plugin-worker-runtime$/,
        replacement: path.join(
          monorepoRoot,
          "packages/plugin-worker-runtime/src/index.ts",
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
      // Source-alias plugin-app-control so view-id drift tests see the current
      // exports (MATCHER_VIEW_IDS / CONTEXT_VIEWS / INTENT_VIEW_IDS) instead of a
      // stale dist build.
      {
        find: /^@elizaos\/plugin-app-control$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-app-control/src/index.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-app-control\/(.+)$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-app-control/src/$1",
        ),
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
    maxWorkers: 1,
    server: {
      deps: {
        inline: [/@elizaos\//, /\/plugins\/plugin-/],
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
