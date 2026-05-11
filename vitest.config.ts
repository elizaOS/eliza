import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.git/**",
      "**/.claude/**",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
    ],
  },
  resolve: {
    alias: [
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.join(root, "packages/app-core/src/index.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.join(root, "packages/app-core/src/$1"),
      },
      {
        find: /^@elizaos\/agent$/,
        replacement: path.join(root, "packages/agent/src/index.ts"),
      },
      {
        find: /^@elizaos\/agent\/(.+)$/,
        replacement: path.join(root, "packages/agent/src/$1"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(root, "packages/core/src/index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: path.join(root, "packages/core/src/$1"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(root, "packages/shared/src/index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(root, "packages/shared/src/$1"),
      },
    ],
  },
});
