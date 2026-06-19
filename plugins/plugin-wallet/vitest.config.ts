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
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts"],
    // Live integration tests require dotenv + a real RPC and are opt-in only
    // (run them via a dedicated script, not the default `vitest run`).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/tasks/**",
      "src/**/*.live.test.ts",
      "src/chains/evm/tests/**",
    ],
  },
});
