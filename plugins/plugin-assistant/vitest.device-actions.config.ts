/** Real HTTP and disk-backed SQL device approval lifecycle. No model or device stubs. */
import { defineConfig } from "vitest/config";
import { buildWorkspaceSourceAliases } from "../../packages/scripts/vitest/source-aliases.ts";
export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: buildWorkspaceSourceAliases(),
  },
  test: {
    environment: "node",
    fileParallelism: false,
    include: [
      "test/device-actions.e2e.test.ts",
      "test/notes-query.e2e.test.ts",
      "test/reminder-relative-create.integration.test.ts",
      "test/workflow-owner-*.test.ts",
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
