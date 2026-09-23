/** Vitest config for this plugin's unit tests (node environment, no source aliasing needed). */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts", "*.test.ts"],
    environment: "node",
  },
});
