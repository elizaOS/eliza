import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

// Real-model lane: identical core-source aliasing, but includes ONLY the
// *.real.test.ts file (which the default config excludes).
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
    include: ["**/*.real.test.ts"],
    testTimeout: 300000,
    hookTimeout: 300000,
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
