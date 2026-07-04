/** Vitest config for the anthropic-proxy plugin: node environment, `__tests__/**` suite, `dist`/`node_modules`/`.live.test.ts` excluded. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/*.live.test.ts"],
    passWithNoTests: false,
    testTimeout: 15_000,
  },
});
