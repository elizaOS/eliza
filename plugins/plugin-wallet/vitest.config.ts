/**
 * Package-level vitest config: aliases local workspace dependencies to source
 * so tests resolve without pre-built dist artifacts, and excludes live/opt-in
 * suites (funded-wallet transfer tests, guarded post-merge-only suites) from
 * the default run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": path.resolve(
        rootDir,
        "../../packages/core/src/index.node.ts",
      ),
      "@elizaos/logger": path.resolve(
        rootDir,
        "../../packages/logger/src/index.ts",
      ),
      // Keep the specific subpath before the package alias because Vite
      // evaluates object aliases in insertion order.
      "@elizaos/shared/automation-node-contributors": path.resolve(
        rootDir,
        "../../packages/shared/src/automation-node-contributors.ts",
      ),
      "@elizaos/shared": path.resolve(
        rootDir,
        "../../packages/shared/src/index.ts",
      ),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/tasks/**",
      // #9310 §E: the guarded live suites (rpc-providers opt-in gate,
      // birdeye keyless self-skip) are invocable only in the post-merge
      // lane, where run-all-tests.mjs prints a named skip accounting. The
      // unguarded transfer.live file (needs a funded wallet) stays excluded
      // in every lane.
      ...(process.env.VITEST_LANE === "post-merge"
        ? ["src/chains/evm/__tests__/integration/transfer.live.test.ts"]
        : ["src/**/*.live.test.ts"]),
      "src/chains/evm/tests/**",
    ],
  },
});
