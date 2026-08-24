/** Runs only the approval-gated, disposable Cerebras AX and CDP fixtures. */

import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      "src/__tests__/computeruse-cerebras-macos-ax-fixture.manual.e2e.test.ts",
      "src/__tests__/computeruse-cerebras-browser-fixture.live.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
