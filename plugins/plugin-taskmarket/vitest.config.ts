/** Vitest config for the taskmarket plugin: resolves `@elizaos/*` to workspace source. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(repoRoot, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(repoRoot, "packages/core/src/$1"),
      },
    ],
    conditions: ["node"],
  },
  ssr: {
    resolve: {
      conditions: ["node"],
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    pool: "forks",
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
