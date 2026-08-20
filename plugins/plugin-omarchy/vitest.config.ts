/**
 * Vitest configuration for the deterministic Omarchy command-boundary suite.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["eliza-source"] },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
