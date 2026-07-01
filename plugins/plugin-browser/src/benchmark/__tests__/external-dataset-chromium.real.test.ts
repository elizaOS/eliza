/**
 * External-dataset lane (#10333) on REAL Chromium.
 *
 * The default external dataset test is CI-safe JSDOM web mode. This gated lane
 * runs the same Mind2Web/WebArena-style records through a real Chromium engine,
 * including a Mind2Web-style SELECT operation, so the external benchmark item is
 * covered by the same browser-engine gate as MiniWoB++ and web grounding.
 */

import type { Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChromiumBenchmarkExecutor,
  EXTERNAL_WEB_DATASET_TASKS,
  launchChromiumBenchmarkBrowser,
  resolveChromiumExecutablePath,
} from "../index.js";
import { NoopPolicy, OraclePolicy, WrongPolicy } from "../policy.js";
import { runBenchmarkSuite } from "../runner.js";

const CHROMIUM = resolveChromiumExecutablePath();

describe.skipIf(!CHROMIUM)(
  "External web dataset through REAL Chromium (#10333)",
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

    it("oracle solves every external fixture through real Chromium commands", async () => {
      const report = await runBenchmarkSuite({
        benchmarkName: "external-web-dataset",
        tasks: EXTERNAL_WEB_DATASET_TASKS,
        seeds: [0],
        policy: new OraclePolicy(),
        makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
      });

      expect(report.benchmark).toBe("external-web-dataset");
      expect(report.engine).toBe("chromium");
      expect(report.summary.total).toBe(EXTERNAL_WEB_DATASET_TASKS.length);
      expect(report.summary.solved).toBe(report.summary.total);
      expect(report.summary.successRate).toBe(1);

      const actionTypes = new Set(
        report.episodes.flatMap((episode) =>
          episode.trajectory.map((step) => step.action.type),
        ),
      );
      expect(actionTypes.has("click")).toBe(true);
      expect(actionTypes.has("fill")).toBe(true);
      expect(actionTypes.has("select")).toBe(true);

      for (const episode of report.episodes) {
        expect(episode.reward, episode.taskId).toBe(1);
        expect(episode.error, episode.taskId).toBeUndefined();
        for (const step of episode.trajectory.filter(
          (entry) => entry.action.type !== "done",
        )) {
          expect(step.resultMode, `${episode.taskId} ${step.action.type}`).toBe(
            "chromium",
          );
          expect(
            step.error,
            `${episode.taskId} ${step.action.type}`,
          ).toBeNull();
        }
      }
    }, 240_000);

    it("noop and wrong baselines fail the external fixture on Chromium", async () => {
      const noop = await runBenchmarkSuite({
        benchmarkName: "external-web-dataset",
        tasks: EXTERNAL_WEB_DATASET_TASKS,
        seeds: [0],
        policy: new NoopPolicy(),
        makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
      });
      expect(noop.engine).toBe("chromium");
      expect(noop.summary.solved).toBe(0);

      const wrong = await runBenchmarkSuite({
        benchmarkName: "external-web-dataset",
        tasks: EXTERNAL_WEB_DATASET_TASKS,
        seeds: [0],
        policy: new WrongPolicy(),
        makeExecutor: () => createChromiumBenchmarkExecutor({ browser }),
      });
      expect(wrong.engine).toBe("chromium");
      expect(wrong.summary.solved).toBe(0);
    }, 240_000);
  },
);
