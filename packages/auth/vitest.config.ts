import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../..");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@elizaos\/core$/, replacement: path.join(coreSrc, "index.node.ts") },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      { find: /^@elizaos\/shared$/, replacement: path.join(sharedSrc, "index.ts") },
      { find: /^@elizaos\/shared\/(.+)$/, replacement: path.join(sharedSrc, "$1") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
