/** Runs only the protected real-Cerebras browser fixture acceptance lane. */

import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      "src/__tests__/computeruse-cerebras-browser-fixture.live.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
