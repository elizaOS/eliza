/**
 * Real-Chromium benchmark lane (#10333 — the deferred "Needs CI infra" item of
 * #9476).
 *
 * Drives the SAME MiniWoB++ suite as `miniwob-adapter.test.ts`, but every action
 * runs through a REAL Chromium process via {@link createChromiumBenchmarkExecutor}
 * (puppeteer-core) instead of JSDOM web mode — the plugin-browser analog of
 * plugin-computeruse's OSWorld `*.real.test.ts` lanes. It is excluded from the
 * default `vitest run` (root `vitest.config.ts` excludes `**\/*.real.test.ts`)
 * and self-skips when no Chromium binary is installed, so it only executes in the
 * gated CI lane that runs `bunx playwright install --with-deps chromium`.
 *
 * The assertions mirror the JSDOM lane exactly — the oracle SOLVES every task on
 * every seed (reward 1) and the noop baseline FAILS every task (reward 0) — which
 * is the engine-parity proof: identical tasks, identical oracle sequences,
 * identical reward, two real engines.
 */

import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  resolveChromiumExecutablePath,
} from "../chromium-executor.js";
import { NoopPolicy, OraclePolicy } from "../policy.js";
import { runBenchmarkSuite } from "../runner.js";
import { MINIWOB_TASKS } from "../tasks.js";

const CHROMIUM = resolveChromiumExecutablePath();
const SEEDS = [0, 1, 2];

describe.skipIf(!CHROMIUM)(
  "MiniWoB++ wired through real plugin-browser on REAL Chromium (#10333)",
  () => {
    // One real browser for the whole suite — a fresh page per episode is cheap,
    // a fresh browser per episode flakes the WS-endpoint start under load.
    let browser: Browser;
    let closeBrowser: () => Promise<void>;
    beforeAll(async () => {
      ({ browser, close: closeBrowser } =
        await launchChromiumBenchmarkBrowser());
    }, 120_000);
    afterAll(async () => {
      await closeBrowser?.();
    });

    it("oracle policy solves every task on every seed (reward 1) through real Chromium", async () => {
      const report = await runBenchmarkSuite({
        seeds: SEEDS,
        policy: new OraclePolicy(),
        makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
      });

      expect(report.engine).toBe("chromium");
      expect(report.benchmark).toBe("miniwob++");
      expect(report.summary.total).toBe(MINIWOB_TASKS.length * SEEDS.length);
      expect(report.summary.solved).toBe(report.summary.total);
      expect(report.summary.successRate).toBe(1);

      for (const ep of report.episodes) {
        expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(1);
        expect(ep.success, `${ep.taskId}#${ep.seed}`).toBe(true);
        expect(ep.error, `${ep.taskId}#${ep.seed}`).toBeUndefined();
        const actionSteps = ep.trajectory.filter(
          (s) => s.action.type !== "done",
        );
        expect(
          actionSteps.length,
          `${ep.taskId}#${ep.seed} has steps`,
        ).toBeGreaterThan(0);
        for (const s of actionSteps) {
          // Every non-terminal step really ran on the chromium engine.
          expect(s.resultMode, `${ep.taskId}#${ep.seed} ${s.action.type}`).toBe(
            "chromium",
          );
          expect(s.error).toBeNull();
        }
      }

      expect(report.summary.byTask).toHaveLength(MINIWOB_TASKS.length);
      for (const t of report.summary.byTask) {
        expect(t.solved, t.taskId).toBe(t.total);
      }
    }, 300_000);

    it("noop baseline scores 0 on real Chromium — reward discriminates, never auto-passes", async () => {
      const report = await runBenchmarkSuite({
        seeds: [0, 1],
        policy: new NoopPolicy(),
        makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
      });
      expect(report.engine).toBe("chromium");
      expect(report.summary.solved).toBe(0);
      expect(report.summary.successRate).toBe(0);
      for (const ep of report.episodes) {
        expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(0);
      }
    }, 180_000);
  },
);
