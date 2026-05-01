import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(packageRoot, "../..");
const srcRoot = path.join(packageRoot, "src");

export default defineConfig({
  resolve: {
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
        find: /^@elizaos\/app-core\/services\/account-pool$/,
        replacement: path.join(
          monorepoRoot,
          "packages/app-core/src/services/account-pool.ts",
        ),
      },
      {
        find: /^@elizaos\/plugin-cli$/,
        replacement: path.join(
          monorepoRoot,
          "plugins/plugin-cli/typescript/src/index.ts",
        ),
      },
    ],
  },
  test: {
    environment: "node",
    server: {
      deps: {
        inline: [/@elizaos\//],
      },
    },
    setupFiles: ["test/setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
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
