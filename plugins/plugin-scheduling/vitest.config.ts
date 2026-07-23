/**
 * Vitest configuration for scheduling runner and route tests in a Node
 * environment.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/shared/runtime-env": fileURLToPath(
        new URL("../../packages/shared/src/runtime-env.ts", import.meta.url),
      ),
      "@elizaos/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
  },
});
