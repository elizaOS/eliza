/**
 * Run real-store personal-assistant integration cases with the package's source
 * aliases and fixture setup. Named test-directory cases join the src glob so
 * the maintained package integration command executes their runtime contracts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { repoRoot } from "../../packages/scripts/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../packages/scripts/vitest/workspace-aliases";
import baseConfig from "./vitest.config";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = getElizaWorkspaceRoot(repoRoot);
const packageRootFromRepo = path
  .relative(elizaRoot, here)
  .split(path.sep)
  .join("/");

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: [
      `${packageRootFromRepo}/src/**/*.integration.test.{ts,tsx}`,
      `${packageRootFromRepo}/test/scheduled-task-action.integration.test.ts`,
      `${packageRootFromRepo}/test/global-pause.integration.test.ts`,
      `${packageRootFromRepo}/test/work-threads.integration.test.ts`,
      `${packageRootFromRepo}/test/approval-queue.integration.test.ts`,
      `${packageRootFromRepo}/test/approval-queue.toctou.integration.test.ts`,
      `${packageRootFromRepo}/test/approval-queue-notify-error.integration.test.ts`,
      `${packageRootFromRepo}/test/book-travel.approval.integration.test.ts`,
      `${packageRootFromRepo}/test/pending-approvals-provider.integration.test.ts`,
      `${packageRootFromRepo}/test/resolve-request-idempotency.integration.test.ts`,
      `${packageRootFromRepo}/test/meeting-ghost.integration.test.ts`,
      `${packageRootFromRepo}/test/resolve-referent-action.integration.test.ts`,
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*-live.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*-real.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
    ],
    coverage: {
      ...baseConfig.test?.coverage,
      enabled: false,
    },
  },
});
