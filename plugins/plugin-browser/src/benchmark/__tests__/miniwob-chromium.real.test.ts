/**
 * Real-Chromium benchmark lane (#10333, follow-up to #9476).
 *
 * The companion to `miniwob-adapter.test.ts` (the JSDOM web-mode lane): it runs
 * the **same** MiniWoB++ suite, oracle, and DOM-grounded reward through the
 * **same** engine-agnostic `BrowserBenchmarkAdapter` seam — but against a **real
 * Chromium** via puppeteer-core instead of JSDOM. This is the deferred
 * "real-Chromium engine lane" from #9476's "Needs CI infra" checklist.
 *
 * Gated like the other `*.real.test.ts` lanes (excluded from the default unit
 * config; run via `packages/test/vitest/real.config.ts`). It self-skips when no
 * Chromium-family browser is resolvable, so it is a clean no-op where one is not
 * installed; CI provisions one with `bunx playwright install chromium`.
 *
 * It asserts both directions on the real engine: the oracle SOLVES every task
 * (reward 1, every step a real `engine: "chromium"` command), and the noop
 * baseline FAILS (reward 0) — so the reward is grounded in real rendered DOM
 * state, not hard-coded to pass.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ChromiumBenchmarkEngine,
  createChromiumBenchmarkEngine,
  resolveChromiumExecutable,
} from "../chromium-executor.js";
import { NoopPolicy, OraclePolicy } from "../policy.js";
import { runBenchmarkSuite } from "../runner.js";
import { MINIWOB_TASKS } from "../tasks.js";

const SEEDS = (process.env.ELIZA_BENCHMARK_SEEDS ?? "0,1,2")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n));

const executablePath = resolveChromiumExecutable();
const describeReal = executablePath ? describe : describe.skip;

if (!executablePath) {
  // eslint-disable-next-line no-console
  console.warn(
    "[miniwob-chromium] no Chromium-family browser found — skipping the real lane " +
      "(set ELIZA_BENCHMARK_CHROMIUM_PATH or run `bunx playwright install chromium`).",
  );
}

describeReal(
  "MiniWoB++ benchmark through a REAL Chromium (puppeteer-core)",
  () => {
    let engine: ChromiumBenchmarkEngine;

    beforeAll(async () => {
      engine = await createChromiumBenchmarkEngine({ headless: true });
      // eslint-disable-next-line no-console
      console.log(
        `[miniwob-chromium] engine launched: ${engine.executablePath}`,
      );
    }, 120_000);

    afterAll(async () => {
      await engine?.close();
    });

    it("oracle policy solves every task on every seed (reward 1) through real Chromium", async () => {
      const report = await runBenchmarkSuite({
        seeds: SEEDS,
        policy: new OraclePolicy(),
        makeExecutor: () => engine.makeExecutor(),
        timestampSource: () => 0,
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
        expect(ep.engine, `${ep.taskId}#${ep.seed}`).toBe("chromium");
        const actionSteps = ep.trajectory.filter(
          (s) => s.action.type !== "done",
        );
        expect(
          actionSteps.length,
          `${ep.taskId}#${ep.seed} has steps`,
        ).toBeGreaterThan(0);
        for (const s of actionSteps) {
          expect(s.resultMode, `${ep.taskId}#${ep.seed} ${s.action.type}`).toBe(
            "web",
          );
          expect(s.error).toBeNull();
        }
      }

      expect(report.summary.byTask).toHaveLength(MINIWOB_TASKS.length);
      for (const t of report.summary.byTask) {
        expect(t.solved, t.taskId).toBe(t.total);
      }
    }, 300_000);

    it("noop policy fails every task (reward 0) — proves the reward reads real DOM", async () => {
      const report = await runBenchmarkSuite({
        seeds: [SEEDS[0] ?? 0],
        policy: new NoopPolicy(),
        makeExecutor: () => engine.makeExecutor(),
        timestampSource: () => 0,
      });
      expect(report.engine).toBe("chromium");
      expect(report.summary.solved).toBe(0);
      expect(report.summary.successRate).toBe(0);
      for (const ep of report.episodes) {
        expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(0);
        expect(ep.success, `${ep.taskId}#${ep.seed}`).toBe(false);
      }
    }, 180_000);
  },
);
