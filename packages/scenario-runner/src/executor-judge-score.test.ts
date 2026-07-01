/**
 * Numeric judge-score serialization (#8795).
 *
 * Before the fix, `JudgeResult.score` only survived inside human detail
 * strings (`"score 0.82 < 0.9: …"`), so training/quality tooling had to
 * re-parse prose to recover the number. These tests prove the score now
 * lands numerically on:
 *
 *   - `TurnReport.judgeScore` (responseJudge, pass AND fail),
 *   - `FinalCheckReport.score` (judgeRubric, pass AND fail),
 *   - `ScenarioReport.judgeScore` (minimum across all judged evaluations),
 *
 * and survives JSON round-tripping as a number.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScenario } from "./executor";

function createJudgedRuntime(scoreByRubricMarker: Record<string, number>) {
  const useModel = vi.fn(async (_type: unknown, params: unknown) => {
    const prompt = String((params as { prompt?: unknown }).prompt ?? "");
    for (const [marker, score] of Object.entries(scoreByRubricMarker)) {
      if (prompt.includes(marker)) {
        return JSON.stringify({ score, reason: `matched ${marker}` });
      }
    }
    throw new Error(`no judge fixture matched prompt: ${prompt.slice(0, 80)}`);
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

describe("judge score serialization (#8795)", () => {
  beforeEach(() => {
    // Force the judge onto the runtime TEXT_LARGE fallback — never Cerebras —
    // regardless of the host env, so the stubbed useModel above serves it.
    vi.stubEnv("EVAL_MODEL_PROVIDER", "runtime");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records the numeric score for passing turn judges and rubric checks", async () => {
    const runtime = createJudgedRuntime({
      "TURN-RUBRIC": 0.82,
      "FINAL-RUBRIC": 0.91,
    });
    const report = await runScenario(
      {
        id: "judge-score-pass",
        title: "Judge score pass",
        domain: "executor",
        turns: [
          {
            kind: "wait",
            name: "judged wait",
            durationMs: 1,
            responseJudge: {
              rubric: "TURN-RUBRIC: reply acknowledges the wait",
              minimumScore: 0.5,
            },
          },
        ],
        finalChecks: [
          {
            type: "judgeRubric",
            name: "final quality",
            rubric: "FINAL-RUBRIC: run completed cleanly",
            minimumScore: 0.5,
          },
        ],
      } as never,
      runtime,
      {
        minJudgeScore: 0.5,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.turns[0]?.judgeScore).toBe(0.82);
    const rubricCheck = report.finalChecks.find(
      (check) => check.type === "judgeRubric",
    );
    expect(rubricCheck?.status).toBe("passed");
    expect(rubricCheck?.score).toBe(0.91);
    // Scenario-level score is the binding (minimum) judged score.
    expect(report.judgeScore).toBe(0.82);

    // The numbers survive JSON serialization — the report file consumers read.
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.judgeScore).toBe(0.82);
    expect(parsed.turns[0].judgeScore).toBe(0.82);
    expect(parsed.finalChecks[0].score).toBe(0.91);
  });

  it("still records the numeric score when the judge fails the scenario", async () => {
    const runtime = createJudgedRuntime({ "FINAL-RUBRIC": 0.3 });
    const report = await runScenario(
      {
        id: "judge-score-fail",
        title: "Judge score fail",
        domain: "executor",
        turns: [],
        finalChecks: [
          {
            type: "judgeRubric",
            name: "final quality",
            rubric: "FINAL-RUBRIC: run completed cleanly",
            minimumScore: 0.9,
          },
        ],
      } as never,
      runtime,
      {
        minJudgeScore: 0.9,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("failed");
    const rubricCheck = report.finalChecks.find(
      (check) => check.type === "judgeRubric",
    );
    expect(rubricCheck?.status).toBe("failed");
    expect(rubricCheck?.score).toBe(0.3);
    expect(report.judgeScore).toBe(0.3);
  });

  it("omits judgeScore when no judge ran", async () => {
    const runtime = createJudgedRuntime({});
    const report = await runScenario(
      {
        id: "judge-score-none",
        title: "No judge",
        domain: "executor",
        turns: [{ kind: "wait", name: "plain wait", durationMs: 1 }],
      } as never,
      runtime,
      {
        minJudgeScore: 0.9,
        providerName: "unit-test",
        turnTimeoutMs: 1_000,
      },
    );

    expect(report.status).toBe("passed");
    expect(report.judgeScore).toBeUndefined();
    expect(report.turns[0]?.judgeScore).toBeUndefined();
  });
});
