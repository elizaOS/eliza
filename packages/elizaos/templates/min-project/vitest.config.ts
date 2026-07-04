/**
 * Vitest configuration for scaffolded minimal app project tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
  },
});
