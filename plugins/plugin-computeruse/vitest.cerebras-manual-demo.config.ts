/** Runs only the approval-gated, disposable Cerebras AX and CDP fixtures. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/__tests__/computeruse-cerebras-macos-ax-fixture.manual.e2e.test.ts",
      "src/__tests__/computeruse-cerebras-browser-fixture.live.e2e.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 240_000,
    hookTimeout: 120_000,
  },
});
