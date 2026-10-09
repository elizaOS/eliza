/** Node-only script contracts run against the same SQLite runtime as their CLI. */
import { defineConfig } from "vitest/config";
import { testOutputPath } from "./lib/test-output.ts";

export default defineConfig({
  test: {
    include: [
      "packages/scripts/__tests__/run-content-context-soak.test.ts",
      "packages/scripts/__tests__/produce-content-context-live-trajectories.test.ts",
    ],
    testTimeout: 120000,
    reporters: ["default", "junit"],
    outputFile: { junit: testOutputPath("script-tests-node", "junit.xml") },
  },
  resolve: { conditions: ["eliza-source"] },
});
