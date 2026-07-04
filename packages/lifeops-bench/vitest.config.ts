import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(fileDir, "../..");
const coreSrc = path.join(monorepoRoot, "packages/core/src");
const sharedSrc = path.join(monorepoRoot, "packages/shared/src");
const cloudRoutingSrc = path.join(monorepoRoot, "packages/cloud/routing/src");
const cloudSdkSrc = path.join(monorepoRoot, "packages/cloud/sdk/src");

export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    server: { deps: { inline: [/@elizaos\//] } },
  },
  resolve: {
    alias: [
      { find: /^@elizaos\/core$/, replacement: path.join(coreSrc, "index.node.ts") },
      { find: /^@elizaos\/core\/(.+)$/, replacement: path.join(coreSrc, "$1") },
      { find: /^@elizaos\/shared$/, replacement: path.join(sharedSrc, "index.ts") },
      { find: /^@elizaos\/shared\/(.+)$/, replacement: path.join(sharedSrc, "$1") },
      { find: /^@elizaos\/cloud-routing$/, replacement: path.join(cloudRoutingSrc, "index.ts") },
      { find: /^@elizaos\/cloud-sdk$/, replacement: path.join(cloudSdkSrc, "index.ts") },
    ],
  },
});
