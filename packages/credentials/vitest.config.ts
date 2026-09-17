/** Runs real authentication and encrypted-storage contracts in one package. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../..");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud/routing/src");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const vaultSrc = path.join(monorepoRoot, "packages/credentials/src/vault");

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/core$/,
        replacement: path.join(coreSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/cloud-routing$/,
        replacement: path.join(cloudRoutingSrc, "index.ts"),
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
        find: /^@elizaos\/credentials\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
    ],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    hookTimeout: 60_000,
    environment: "node",
    testTimeout: 60_000,
  },
});
