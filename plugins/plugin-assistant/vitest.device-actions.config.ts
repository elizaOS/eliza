/** Real HTTP/SQL device approvals and original replies; provider ports stay closed. */
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
      "test/device-read-completion.test.ts",
      "test/device-read-completion-pipeline.test.ts",
      "test/notes-query.e2e.test.ts",
      "test/reminder-relative-create.integration.test.ts",
      "test/workflow-owner-*.test.ts",
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
