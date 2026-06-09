import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");
const sharedSrc = path.join(repoRoot, "packages/shared/src");

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
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(repoRoot, "packages/logger/src/index.ts"),
      },
      {
        find: /^@elizaos\/logger\/(.+)$/,
        replacement: path.join(repoRoot, "packages/logger/src/$1"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(sharedSrc, "$1"),
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
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 15_000,
    passWithNoTests: true,
    pool: "forks",
    server: {
      deps: {
        inline: ["@elizaos/core", "@elizaos/shared"],
      },
    },
  },
});
