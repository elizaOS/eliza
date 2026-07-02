/**
 * Judge-independence governance (#9310).
 *
 * When no independent Cerebras judge is configured, judge.ts falls back to the
 * runtime's own TEXT_LARGE model — the model under test grades itself. These
 * tests prove that self-grading is fail-loud-visible:
 *
 *   - the scenario report is stamped `judgeSelfGraded: true`,
 *   - `SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1` turns the self-graded scenario
 *     into a failure (the nightly live lane sets it),
 *   - deterministic-proxy lanes (fixture-served judges) are NOT stamped,
 *   - scenarios that never ran a judge are NOT stamped.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

function createJudgedRuntime(score = 0.9) {
  const useModel = vi.fn(async (_type: unknown, params: unknown) => {
    const prompt = String((params as { prompt?: unknown }).prompt ?? "");
    if (prompt.includes("Score the candidate response against the rubric")) {
      return JSON.stringify({ score, reason: "self-graded fallback" });
    }
    throw new Error(`unexpected model call: ${prompt.slice(0, 80)}`);
  });
  return {
    actions: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    setSetting: vi.fn(),
    useModel,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as AgentRuntime;
}

function judgedScenario(id: string) {
  return {
    id,
    title: "Judge independence",
    domain: "executor",
    turns: [],
    finalChecks: [
      {
        type: "judgeRubric",
        name: "final quality",
        rubric: "run completed cleanly",
        minimumScore: 0.5,
      },
    ],
  } as never;
}

const RUN_OPTS = {
  minJudgeScore: 0.5,
  providerName: "unit-test",
  turnTimeoutMs: 1_000,
};

describe("judge self-grading governance (#9310)", () => {
  beforeEach(() => {
    // Force the judge onto the runtime TEXT_LARGE fallback — never Cerebras —
    // and make sure no proxy/strict flags leak in from the host env.
    vi.stubEnv("EVAL_MODEL_PROVIDER", "runtime");
    vi.stubEnv("SCENARIO_USE_LLM_PROXY", "");
    vi.stubEnv("ELIZA_SCENARIO_USE_LLM_PROXY", "");
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps judgeSelfGraded when the runtime fallback judge scored the run", async () => {
    const report = await runScenario(
      judgedScenario("judge-self-graded-stamp"),
      createJudgedRuntime(),
      RUN_OPTS,
    );
    expect(report.status).toBe("passed");
    expect(report.judgeSelfGraded).toBe(true);
    // The stamp survives the JSON report consumers read.
    expect(JSON.parse(JSON.stringify(report)).judgeSelfGraded).toBe(true);
  });

  it("fails self-graded scenarios under SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1", async () => {
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "1");
    const report = await runScenario(
      judgedScenario("judge-self-graded-strict"),
      createJudgedRuntime(),
      RUN_OPTS,
    );
    expect(report.status).toBe("failed");
    expect(report.judgeSelfGraded).toBe(true);
    const failure = report.failedAssertions.find(
      (f) => f.label === "judgeIndependence",
    );
    expect(failure?.detail).toContain("model under test");
    expect(failure?.detail).toContain("CEREBRAS_API_KEY");
  });

  it("does not stamp deterministic-proxy lanes (fixtures answer the judge)", async () => {
    vi.stubEnv("SCENARIO_USE_LLM_PROXY", "1");
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "1");
    const report = await runScenario(
      judgedScenario("judge-proxy-lane"),
      createJudgedRuntime(),
      RUN_OPTS,
    );
    expect(report.status).toBe("passed");
    expect(report.judgeSelfGraded).toBeUndefined();
  });

  it("does not stamp scenarios that never ran a judge", async () => {
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "1");
    const report = await runScenario(
      {
        id: "judge-never-ran",
        title: "No judge",
        domain: "executor",
        turns: [],
        finalChecks: [],
      } as never,
      createJudgedRuntime(),
      RUN_OPTS,
    );
    expect(report.status).toBe("passed");
    expect(report.judgeSelfGraded).toBeUndefined();
  });
});
