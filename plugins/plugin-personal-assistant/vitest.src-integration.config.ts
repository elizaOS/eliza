// Runner for the package's src-level integration tests (real DB runtime,
// injected tick clock) — currently the scheduled-task tick suites:
//
//   src/lifeops/scheduled-task/scheduler.integration.test.ts
//   src/lifeops/scheduled-task/scheduler-recurrence.integration.test.ts
//   test/global-pause.integration.test.ts
//
// These were dead in CI: the package's unit lane (vitest.config.ts) excludes
// the *.integration.test.ts suffix, and the repo integration lane only globs
// the plugin test/ directories (never src/). This config reuses the package's
// full resolve/alias/setup wiring and swaps the include to the src
// integration suffix. Wired into the package's test:integration script so
// the orchestrator (run-all-tests.mjs EXTRA_SCRIPT_NAMES) drains it.
//
// test/global-pause.integration.test.ts is included by name: it drives the
// same real-runtime tick (`processDueScheduledTasks` + PGlite) and needs this
// config's alias wiring. The repo-level integration config cannot boot the PA
// plugin barrel (its `@elizaos/core` string alias breaks the `/node` subpath
// import that `@elizaos/plugin-x`'s dist pulls in), and the package's
// test:integration script only names two test/ files there — so the pause
// test never ran anywhere before this wiring. Approval-queue integration specs
// are included by name for the same reason: they boot the real PGlite runtime
// and need this package's first-party source aliases instead of dist entries.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { repoRoot } from "../../packages/test/vitest/repo-root";
import { getElizaWorkspaceRoot } from "../../packages/test/vitest/workspace-aliases";
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
      `${packageRootFromRepo}/test/approval-queue.integration.test.ts`,
      `${packageRootFromRepo}/test/approval-queue-notify-error.integration.test.ts`,
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
