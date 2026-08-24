/** Focused app-control gate that does not traverse unrelated workspace packages. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/app-control/coordinator.test.ts",
      "src/app-control/route-policy.test.ts",
      "src/app-control/macos-ax-packaging.test.ts",
      "src/__tests__/mcp-tools.test.ts",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
