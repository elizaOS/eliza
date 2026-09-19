/**
 * Exercises scenario grading and serialized evidence with deterministic judge
 * outputs. Missing model identity remains unknown and fails the strict gate;
 * explicit fixture lanes and scenarios without judgments are distinguished.
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
    plugins: [],
    routes: [],
    ensureConnection: vi.fn(async () => undefined),
    getTasksByName: async () => [],
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
    vi.stubEnv("SCENARIO_USE_DETERMINISTIC_MODEL", "");
    vi.stubEnv("ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL", "");
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports unknown identity when the fallback emits no model observations", async () => {
    const report = await runScenario(
      judgedScenario("judge-self-graded-stamp"),
      createJudgedRuntime(),
      RUN_OPTS,
    );
    const persisted = JSON.parse(JSON.stringify(report));
    expect(persisted.finalChecks[0].judgment.evidence.prompt).toContain(
      "run completed cleanly",
    );
    expect(persisted.finalChecks[0].judgment.evidence.attempts).toEqual([
      {
        raw: JSON.stringify({ score: 0.9, reason: "self-graded fallback" }),
        accepted: true,
      },
    ]);
    expect(report.status).toBe("passed");
    expect(report.judgeIndependence).toBe("unknown");
    expect(report.judgeSelfGraded).toBeUndefined();
    // The stamp survives the JSON report consumers read.
    expect(JSON.parse(JSON.stringify(report)).judgeIndependence).toBe(
      "unknown",
    );
  });

  it("fails identity-unverified scenarios under SCENARIO_JUDGE_REQUIRE_INDEPENDENT=1", async () => {
    vi.stubEnv("SCENARIO_JUDGE_REQUIRE_INDEPENDENT", "1");
    const report = await runScenario(
      judgedScenario("judge-self-graded-strict"),
      createJudgedRuntime(),
      RUN_OPTS,
    );
    expect(report.status).toBe("failed");
    expect(report.judgeIndependence).toBe("unknown");
    expect(report.judgeSelfGraded).toBeUndefined();
    const failure = report.failedAssertions.find(
      (f) => f.label === "judgeIndependence",
    );
    expect(failure?.detail).toContain("model under test");
    expect(failure?.detail).toContain("CEREBRAS_API_KEY");
  });

  it("retains every invalid final-check response in the serialized report", async () => {
    const runtime = createJudgedRuntime();
    const raw = `${"invalid response ".repeat(10000)}tail`;
    runtime.useModel = vi.fn(async () => raw) as AgentRuntime["useModel"];
    const report = await runScenario(
      judgedScenario("judge-invalid-evidence"),
      runtime,
      RUN_OPTS,
    );
    const persisted = JSON.parse(JSON.stringify(report));
    expect(persisted.status).toBe("failed");
    expect(persisted.finalChecks[0].judgeFailure.attempts).toEqual(
      Array.from({ length: 3 }, () => ({ raw, accepted: false })),
    );
  });

  it("does not stamp deterministic-proxy lanes (fixtures answer the judge)", async () => {
    vi.stubEnv("SCENARIO_USE_DETERMINISTIC_MODEL", "1");
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
