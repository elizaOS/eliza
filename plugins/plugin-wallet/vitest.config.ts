import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // app-core only ships a built-dist export condition; point the automation
      // node contributor registry at source so vitest resolves it without a
      // pre-built app-core dist (the module is type-only at runtime).
      "@elizaos/app-core/api/automation-node-contributors": path.resolve(
        rootDir,
        "../../packages/app-core/src/api/automation-node-contributors.ts",
      ),
      "@elizaos/core": path.resolve(
        rootDir,
        "../../packages/core/src/index.node.ts",
      ),
      "@elizaos/logger": path.resolve(
        rootDir,
        "../../packages/logger/src/index.ts",
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
