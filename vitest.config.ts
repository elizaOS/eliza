import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(root, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(root, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/cloud-sdk$/,
        replacement: path.join(root, "packages/cloud-sdk/src/index.ts"),
      },
      {
        find: /^@elizaos\/cloud-sdk\/(.+)$/,
        replacement: path.join(root, "packages/cloud-sdk/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(root, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(root, "packages/tui/src/$1"),
      },
      {
        find: /^@elizaos\/ui$/,
        replacement: path.join(root, "packages/ui/src/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/(.+)$/,
        replacement: path.join(root, "packages/ui/src/$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(root, "packages/vault/src/index.ts"),
      },
      {
        find: /^@elizaos\/vault\/(.+)$/,
        replacement: path.join(root, "packages/vault/src/$1"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(root, "packages/tui/src/index.ts"),
      },
      {
        find: /^@elizaos\/tui\/(.+)$/,
        replacement: path.join(root, "packages/tui/src/$1"),
      },
    ],
  },
});
