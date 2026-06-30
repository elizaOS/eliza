/**
 * Mind2Web replay through real plugin-browser on REAL Chromium (#10333 — the
 * external-dataset lane of #9476's deferred list).
 *
 * `packages/benchmarks/mind2web/eliza_agent.py` scores Mind2Web through the
 * inference layer and never executes the action through plugin-browser. This
 * lane replays a Mind2Web-format CLICK → TYPE → SELECT sequence through the REAL
 * BROWSER command surface on a real Chromium and verifies each step's effect via
 * a real `get` read. It runs the embedded fixture by default and the full
 * `osunlp/Mind2Web` corpus when `MIND2WEB_DATA_DIR` is set.
 *
 * Excluded from the default `vitest run` (`.real.test.ts`) and self-skips without
 * a Chromium binary; runs in the gated CI lane after
 * `bunx playwright install --with-deps chromium`.
 */

import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  resolveChromiumExecutablePath,
} from "../chromium-executor.js";
import {
  loadMind2WebTasks,
  MIND2WEB_FIXTURE,
  replayMind2WebTask,
  runMind2WebSuite,
} from "../mind2web.js";

const CHROMIUM = resolveChromiumExecutablePath();

describe.skipIf(!CHROMIUM)(
  "Mind2Web replay through real plugin-browser on REAL Chromium (#10333)",
  () => {
    let browser: Browser;
    let closeBrowser: () => Promise<void>;
    beforeAll(async () => {
      ({ browser, close: closeBrowser } =
        await launchChromiumBenchmarkBrowser());
    }, 120_000);
    afterAll(async () => {
      await closeBrowser?.();
    });

    it(
      "replays a Mind2Web CLICK→TYPE→SELECT sequence — every step executes + verifies",
      async () => {
        const { tasks, source } = loadMind2WebTasks();
        const { executor, dispose } = await createChromiumBenchmarkExecutor({
          browser,
        });
        try {
          const report = await runMind2WebSuite(executor, tasks, source);
          expect(report.engine).toBe("chromium");
          expect(report.benchmark).toBe("mind2web");
          expect(report.summary.tasks).toBe(tasks.length);
          // Every step of every task executed AND its DOM effect verified.
          expect(report.summary.stepAccuracy).toBe(1);
          expect(report.summary.solved).toBe(tasks.length);
          for (const t of report.tasks) {
            for (const s of t.steps) {
              expect(s.executed, `${t.taskId}/${s.actionUid}`).toBe(true);
              expect(s.verified, `${t.taskId}/${s.actionUid}`).toBe(true);
              expect(s.error, `${t.taskId}/${s.actionUid}`).toBeNull();
            }
          }
          // The fixture exercised all three Mind2Web operations through real
          // BROWSER commands.
          const ops = new Set(
            report.tasks.flatMap((t) => t.steps.map((s) => s.operation)),
          );
          expect(ops.has("CLICK")).toBe(true);
          expect(ops.has("TYPE")).toBe(true);
          expect(ops.has("SELECT")).toBe(true);
        } finally {
          await dispose();
        }
      },
      180_000,
    );

    it(
      "a wrong target selector makes the step fail — the replay is honest",
      async () => {
        const { executor, dispose } = await createChromiumBenchmarkExecutor({
          browser,
        });
        try {
          // Same task, but every target points at a missing element.
          const broken = {
            ...MIND2WEB_FIXTURE,
            id: "fixture_broken",
            steps: MIND2WEB_FIXTURE.steps.map((s) => ({
              ...s,
              targetSelector: "#does-not-exist",
            })),
          };
          const report = await replayMind2WebTask(executor, broken);
          expect(report.success).toBe(false);
          expect(report.verifiedSteps).toBe(0);
          for (const s of report.steps) {
            // No element to act on → the operation command throws.
            expect(s.executed, s.actionUid).toBe(false);
            expect(s.error, s.actionUid).not.toBeNull();
          }
        } finally {
          await dispose();
        }
      },
      120_000,
    );
  },
);
