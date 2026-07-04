/**
 * Vitest configuration for plugin-vision unit and integration suites.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/tests/e2e/**",
      "**/*.e2e.test.*",
      "**/*.live.test.*",
      "**/*.live.e2e.test.*",
      // #9310 §E: the OCR *.real.test.ts suites (platform-probed, self-skip
      // off-host) are invocable only in the post-merge lane, where
      // run-all-tests.mjs prints a named skip accounting.
      ...(process.env.VITEST_LANE === "post-merge" ? [] : ["**/*.real.test.*"]),
      "**/*.real.e2e.test.*",
    ],
    // Give more time for tests that load heavy dependencies
    testTimeout: 30000,
  },
});
