/** Runs real authentication and encrypted-storage contracts in one package. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, "../..");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud/routing/src");
const vaultSrc = path.join(monorepoRoot, "packages/auth/src/vault");

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
        find: /^@elizaos\/auth\/vault$/,
        replacement: path.join(vaultSrc, "index.ts"),
      },
    ],
  },
  test: {
    include: [
      "src/auth/**/*.test.ts",
      "src/vault/**/*.test.ts",
      "src/kms/**/*.test.ts",
      "test/*.test.ts",
    ],
    hookTimeout: 60_000,
    environment: "node",
    testTimeout: 60_000,
  },
});
