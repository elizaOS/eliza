/**
 * Vitest configuration for form unit tests and post-merge-gated live extraction
 * suites.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "dist/**",
      "node_modules/**",
      // Live extraction tests self-skip keyless and only run in post-merge.
      ...(process.env.VITEST_LANE === "post-merge"
        ? []
        : ["src/**/*.live.test.ts", "test/**/*.live.test.ts"]),
    ],
  },
});
