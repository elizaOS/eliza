/**
 * Vitest config for @elizaos/evidence: node environment, real-filesystem unit
 * and integration tests under `src`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
  },
});
