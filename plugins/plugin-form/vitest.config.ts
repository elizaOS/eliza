/**
 * Vitest configuration for form unit tests and post-merge-gated live extraction
 * suites.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The live suite imports the package by its public name. Use the workspace
    // source condition so a clean checkout does not depend on a prebuilt dist.
    alias: {
      "@elizaos/plugin-form": fileURLToPath(
        new URL("./src/index.ts", import.meta.url),
      ),
    },
    conditions: ["eliza-source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "dist/**",
      "node_modules/**",
      // Live extraction tests self-skip keyless and only run in post-merge.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["src/**/*.live.test.ts", "test/**/*.live.e2e.test.ts"]),
    ],
  },
});
