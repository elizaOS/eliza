import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../..");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const loggerSrc = path.join(monorepoRoot, "packages/logger/src");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const vaultSrc = path.join(monorepoRoot, "packages/vault/src");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/atomic-json$/,
        replacement: path.join(coreSrc, "utils/atomic-json.ts"),
      },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      {
        find: /^@elizaos\/logger$/,
        replacement: path.join(loggerSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared$/,
        replacement: path.join(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: path.join(sharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
