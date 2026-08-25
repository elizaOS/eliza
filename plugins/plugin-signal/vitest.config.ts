/** Vitest config for @elizaos/plugin-signal: node environment, runs the co-located `src/**` and `__tests__/**` suites. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
