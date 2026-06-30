/**
 * Real-code benchmark lane (#9476).
 *
 * Drives the MiniWoB++ suite through the REAL `executeBrowserWorkspaceCommand`
 * router (web mode) via {@link createWorkspaceBenchmarkExecutor} — no mock
 * service stands in for the browser. This is the plugin-browser analog of
 * plugin-computeruse's OSWorld `*.real.test.ts` lanes, and the CI-asserted proof
 * that a benchmark is wired end-to-end through plugin-browser.
 *
 * It asserts both directions: the oracle policy SOLVES every task (reward 1),
 * and the noop/adversarial baselines FAIL every task (reward 0) — so the reward
 * is grounded in real DOM state, not hard-coded to pass.
 */

import { describe, expect, it } from "vitest";
import {
  BrowserBenchmarkAdapter,
  createWorkspaceBenchmarkExecutor,
} from "../adapter.js";
import { NoopPolicy, OraclePolicy, WrongPolicy } from "../policy.js";
import { runBenchmarkSuite } from "../runner.js";
import { getTaskById, MINIWOB_TASKS } from "../tasks.js";

const fixedClock = () => 0;
const SEEDS = [0, 1, 2];

describe("MiniWoB++ benchmark wired through real plugin-browser", () => {
  it("oracle policy solves every task on every seed (reward 1) through the real router", async () => {
    const report = await runBenchmarkSuite({
      seeds: SEEDS,
      policy: new OraclePolicy(),
      timestampSource: fixedClock,
    });

    expect(report.engine).toBe("jsdom-web");
    expect(report.benchmark).toBe("miniwob++");
    expect(report.summary.total).toBe(MINIWOB_TASKS.length * SEEDS.length);
    expect(report.summary.solved).toBe(report.summary.total);
    expect(report.summary.successRate).toBe(1);

    for (const ep of report.episodes) {
      expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(1);
      expect(ep.success, `${ep.taskId}#${ep.seed}`).toBe(true);
      expect(ep.error, `${ep.taskId}#${ep.seed}`).toBeUndefined();
      // every non-terminal step actually executed a real web-mode command
      const actionSteps = ep.trajectory.filter((s) => s.action.type !== "done");
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

    // every task is represented and fully solved
    expect(report.summary.byTask).toHaveLength(MINIWOB_TASKS.length);
    for (const t of report.summary.byTask) {
      expect(t.solved, t.taskId).toBe(t.total);
    }
  });

  it("noop baseline scores 0 on every task — reward discriminates, never auto-passes", async () => {
    const report = await runBenchmarkSuite({
      seeds: SEEDS,
      policy: new NoopPolicy(),
      timestampSource: fixedClock,
    });
    expect(report.summary.solved).toBe(0);
    expect(report.summary.successRate).toBe(0);
    for (const ep of report.episodes) {
      expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(0);
    }
  });

  it("adversarial (wrong-target / wrong-text) baseline scores 0 on every task", async () => {
    const report = await runBenchmarkSuite({
      seeds: [0, 1],
      policy: new WrongPolicy(),
      timestampSource: fixedClock,
    });
    expect(report.summary.solved).toBe(0);
    for (const ep of report.episodes) {
      expect(ep.reward, `${ep.taskId}#${ep.seed}`).toBe(0);
    }
  });

  it("surfaces a real workspace error when an action targets a missing element", async () => {
    const { executor, dispose } = await createWorkspaceBenchmarkExecutor({});
    try {
      const adapter = new BrowserBenchmarkAdapter(executor);
      const task = getTaskById("click-button");
      expect(task).toBeDefined();
      if (!task) return;
      await adapter.loadTask(task, 0);

      const res = await adapter.executeAction({
        type: "click",
        selector: "#wob-does-not-exist",
      });
      expect(res.commandResult).toBeNull();
      expect(res.error).toBeDefined();
      expect(res.error?.message ?? "").toMatch(/not found|target/i);
    } finally {
      await dispose();
    }
  });

  it("observation reads the live #wob-query goal back through real BROWSER get", async () => {
    const { executor, dispose } = await createWorkspaceBenchmarkExecutor({});
    try {
      const adapter = new BrowserBenchmarkAdapter(executor);
      const task = getTaskById("enter-text");
      if (!task) throw new Error("enter-text task missing");
      const obs = await adapter.loadTask(task, 1);
      expect(obs.url).toContain("enter-text");
      expect(obs.title).toBe("Enter Text");
      // the natural-language goal is observable in the live DOM, MiniWoB-style
      expect(obs.bodyText.toLowerCase()).toContain("text field");
    } finally {
      await dispose();
    }
  });
});
