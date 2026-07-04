/**
 * Vitest config for the robot package's thin TypeScript surface.
 *
 * Python and live robotics tests are excluded here; package scripts run those
 * through the separate pytest lane.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 60_000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/**",
      "**/*.e2e.test.*",
      "**/*.live.test.*",
      "**/*.real.test.*",
    ],
  },
});
