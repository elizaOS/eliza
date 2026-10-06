/** Runs real authentication and encrypted-storage contracts in one package. */
import { defineConfig } from "vitest/config";

import {
  buildWorkspaceSourceAliases,
  workspaceRepoRoot,
} from "../scripts/vitest/source-aliases.ts";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: buildWorkspaceSourceAliases(workspaceRepoRoot),
  },
  test: {
    // Isolate PGlite/WASM teardown in separate processes. The thread pool can
    // abort Node 24 in ThreadIsolation::UnregisterWasmAllocation on Linux.
    pool: "forks",
    maxWorkers: 1,
    server: { deps: { inline: [/@elizaos\//] } },
    include: [
      "src/auth/**/*.test.ts",
      "src/accounts/**/*.test.ts",
      "src/vault/**/*.test.ts",
      "src/kms/**/*.test.ts",
      "src/providers/**/*.test.ts",
      "test/*.test.ts",
    ],
    hookTimeout: 60_000,
    environment: "node",
    testTimeout: 60_000,
  },
});
