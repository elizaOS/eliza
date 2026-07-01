import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");

// Resolve @elizaos/core to its SOURCE (index.node.ts) rather than the built
// dist. The PII entity-recognizer seam (canonicalKind / PII_ENTITY_RECOGNIZER_
// SERVICE / EntitySpan) is newer than the committed core dist, so bare
// resolution would hit a stale bundle. Mirrors plugin-coding-tools.
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
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/e2e/**",
      "**/*.e2e.test.*",
      "**/*.live.test.*",
      "**/*.live.e2e.test.*",
      "**/*.real.test.*",
      "**/*.real.e2e.test.*",
    ],
    testTimeout: 30000,
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
