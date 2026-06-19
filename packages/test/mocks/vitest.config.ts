import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesRoot = path.resolve(here, "../..");
const elizaCoreShimPath = path.join(here, "helpers", "elizaos-core-shim.ts");

export default defineConfig({
  root: packagesRoot,
  resolve: {
    alias: [
      {
        find: "@elizaos/core",
        replacement: elizaCoreShimPath,
      },
    ],
    dedupe: ["@elizaos/core"],
  },
  test: {
    include: ["test/mocks/__tests__/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "forks",
    forks: { singleFork: true },
  },
});
