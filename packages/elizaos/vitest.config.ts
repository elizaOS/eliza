/**
 * Vitest configuration for the CLI package unit tests; templates are excluded
 * because generated projects carry their own test configuration.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "templates/**"],
  },
});
