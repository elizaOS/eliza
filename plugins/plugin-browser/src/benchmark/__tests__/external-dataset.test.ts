/**
 * External-dataset benchmark lane (#10333).
 *
 * The committed fixture is small, but it preserves the integration property
 * the issue needs: dataset rows compile into benchmark tasks, and every oracle
 * action is dispatched through real plugin-browser BROWSER commands.
 */

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_WEB_DATASET_FIXTURE,
  EXTERNAL_WEB_DATASET_TASKS,
} from "../external-dataset.js";
import { NoopPolicy, OraclePolicy, WrongPolicy } from "../policy.js";
import { runBenchmarkSuite } from "../runner.js";

const fixedClock = () => 0;

describe("external dataset benchmark wired through real plugin-browser", () => {
  it("converts committed Mind2Web/WebArena-style records into benchmark tasks", () => {
    expect(EXTERNAL_WEB_DATASET_FIXTURE).toHaveLength(3);
    expect(EXTERNAL_WEB_DATASET_TASKS.map((task) => task.id)).toEqual(
      EXTERNAL_WEB_DATASET_FIXTURE.map((record) => record.id),
    );
    expect(
      new Set(
        EXTERNAL_WEB_DATASET_FIXTURE.map((record) => record.sourceDataset),
      ),
    ).toEqual(new Set(["Mind2Web", "WebArena"]));

    for (const record of EXTERNAL_WEB_DATASET_FIXTURE) {
      expect(record.routes.length, record.id).toBeGreaterThan(0);
      expect(record.trace.length, record.id).toBeGreaterThan(0);
      expect(record.reward.length, record.id).toBeGreaterThan(0);
    }
  });

  it("oracle policy solves the external dataset fixture through the real router", async () => {
    const report = await runBenchmarkSuite({
      benchmarkName: "external-web-dataset",
      tasks: EXTERNAL_WEB_DATASET_TASKS,
      seeds: [0],
      policy: new OraclePolicy(),
      timestampSource: fixedClock,
    });

    expect(report.benchmark).toBe("external-web-dataset");
    expect(report.engine).toBe("jsdom-web");
    expect(report.summary.total).toBe(EXTERNAL_WEB_DATASET_TASKS.length);
    expect(report.summary.solved).toBe(report.summary.total);
    expect(report.summary.successRate).toBe(1);

    for (const ep of report.episodes) {
      expect(ep.reward, ep.taskId).toBe(1);
      expect(ep.error, ep.taskId).toBeUndefined();
      for (const step of ep.trajectory.filter(
        (s) => s.action.type !== "done",
      )) {
        expect(step.resultMode, `${ep.taskId} ${step.action.type}`).toBe("web");
        expect(step.error, `${ep.taskId} ${step.action.type}`).toBeNull();
      }
    }
  });

  it("negative baselines fail the external dataset fixture", async () => {
    const noop = await runBenchmarkSuite({
      benchmarkName: "external-web-dataset",
      tasks: EXTERNAL_WEB_DATASET_TASKS,
      seeds: [0],
      policy: new NoopPolicy(),
      timestampSource: fixedClock,
    });
    expect(noop.summary.solved).toBe(0);

    const wrong = await runBenchmarkSuite({
      benchmarkName: "external-web-dataset",
      tasks: EXTERNAL_WEB_DATASET_TASKS,
      seeds: [0],
      policy: new WrongPolicy(),
      timestampSource: fixedClock,
    });
    expect(wrong.summary.solved).toBe(0);
  });
});
