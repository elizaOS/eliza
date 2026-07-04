/**
 * Vitest config for @elizaos/logger: node environment, runs `src` unit tests.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
