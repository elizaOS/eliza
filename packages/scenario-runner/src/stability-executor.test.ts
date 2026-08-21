/**
 * Deterministic contract tests for the standalone stability executor. The
 * injected boundary simulates fresh runtime attempts; no model or service mock
 * package is substituted for the executor under test.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScenarioStabilityPlan } from "./stability.ts";
import type {
  ScenarioStabilityAttemptExecution,
  ScenarioStabilityExecutionAdapter,
} from "./stability-executor.ts";
import { executeScenarioStability } from "./stability-executor.ts";

const INITIAL_HASH = "a".repeat(64);

function passingExecution(
  overrides: Partial<ScenarioStabilityAttemptExecution> = {},
): ScenarioStabilityAttemptExecution {
  return {
    passed: true,
    initialStateHash: INITIAL_HASH,
    finalStateHash: "b".repeat(64),
    inputTokens: 10,
    outputTokens: 5,
    toolCalls: 1,
    evidence: {
      trajectory: [{ stage: "model" }],
      toolReceipts: [{ tool: "SEND_MESSAGE" }],
      stateTransitions: [{ from: "pending", to: "sent" }],
      providerReceipts: [{ provider: "test-provider" }],
      judgeVerdicts: [{ passed: true, score: 1 }],
    },
    stateDiff: { sent: true },
    ...overrides,
  };
}

describe("scenario stability executor", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function plan(runId: string) {
    const root = mkdtempSync(
      path.join(tmpdir(), "scenario-stability-executor-"),
    );
    roots.push(root);
    return createScenarioStabilityPlan({ runId, outputRoot: root });
  }

  it("runs all three attempts with unique identities and requires three of three", async () => {
    const executed: string[] = [];
    const terminated: string[] = [];
    const report = await executeScenarioStability({
      plan: plan("strict-pass"),
      targets: [
        {
          scenarioId: "send-a-message",
          model: { provider: "test-provider", model: "best-case" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxToolCalls: 3,
      },
      adapter: {
        async execute({ attemptId, outputDir }) {
          executed.push(attemptId);
          expect(outputDir).toContain("attempt-0");
          return passingExecution();
        },
        async terminate({ attemptId }) {
          terminated.push(attemptId);
        },
      },
    });

    expect(executed).toHaveLength(3);
    expect(new Set(executed).size).toBe(3);
    expect(terminated).toEqual(executed);
    expect(report).toMatchObject({
      status: "passed",
      attemptCount: 3,
      requiredTier: "3/3",
      cells: [
        {
          firstAttemptPassed: true,
          passedAttempts: 3,
          tier: "3/3",
          strictPassed: true,
        },
      ],
      focusList: [],
    });
  });

  it("does not retry until green: it measures and records every attempt", async () => {
    const calls: number[] = [];
    const report = await executeScenarioStability({
      plan: plan("strict-failure"),
      targets: [
        {
          scenarioId: "schedule-reminder",
          model: { provider: "test-provider", model: "best-case" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxToolCalls: 3,
      },
      adapter: {
        async execute({ attemptNumber }) {
          calls.push(attemptNumber);
          return passingExecution({
            passed: attemptNumber !== 2,
            ...(attemptNumber === 2 ? { error: "wrong action selected" } : {}),
          });
        },
        async terminate() {},
      },
    });

    expect(calls).toEqual([1, 2, 3]);
    expect(report.status).toBe("failed");
    expect(report.cells[0]).toMatchObject({
      firstAttemptPassed: true,
      passedAttempts: 2,
      tier: "2/3",
      strictPassed: false,
    });
    expect(report.focusList[0]).toMatchObject({
      tier: "2/3",
      firstAttemptPassed: true,
      failureClassifications: ["scenario-failure"],
    });
  });

  it("continues after harness errors, timeouts, and teardown failures", async () => {
    const calls: number[] = [];
    const terminated: number[] = [];
    const adapter: ScenarioStabilityExecutionAdapter = {
      async execute({ attemptNumber, signal }) {
        calls.push(attemptNumber);
        if (attemptNumber === 1) throw new Error("runtime boot failed");
        if (attemptNumber === 2) {
          await new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        }
        return passingExecution();
      },
      async terminate({ attemptNumber, signal }) {
        terminated.push(attemptNumber);
        if (attemptNumber === 1) {
          await new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        }
        if (attemptNumber === 3) throw new Error("cleanup failed");
      },
    };
    const report = await executeScenarioStability({
      plan: plan("harness-failures"),
      targets: [
        {
          scenarioId: "notify-user",
          model: { provider: "test-provider", model: "best-case" },
        },
      ],
      budgets: {
        timeoutMs: 10,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxToolCalls: 3,
      },
      adapter,
    });

    expect(calls).toEqual([1, 2, 3]);
    expect(terminated).toEqual([1, 2, 3]);
    expect(report.cells[0]).toMatchObject({ tier: "0/3", strictPassed: false });
    expect(report.cells[0]?.attempts[0]?.error).toContain(
      "attempt teardown exceeded 10ms",
    );
    expect(
      report.cells[0]?.attempts.every(
        (attempt) => attempt.failureClassification === "harness-failure",
      ),
    ).toBe(true);
  });

  it("retains returned evidence when a budget fails and accepts a zero-tool budget", async () => {
    const report = await executeScenarioStability({
      plan: plan("budget-evidence"),
      targets: [
        {
          scenarioId: "model-only",
          model: { provider: "test-provider", model: "best-case" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 9,
        maxOutputTokens: 100,
        maxToolCalls: 0,
      },
      adapter: {
        async execute() {
          return passingExecution({ toolCalls: 0 });
        },
        async terminate() {},
      },
    });

    const attempt = report.cells[0]?.attempts[0];
    expect(attempt).toMatchObject({
      passed: false,
      inputTokens: 10,
      failureClassification: "scenario-failure",
      error: "inputTokens 10 exceeds its stability budget 9",
    });
    expect(attempt?.evidence.trajectory).toEqual([{ stage: "model" }]);
    expect(report.cells[0]?.tier).toBe("0/3");
  });

  it("fails closed when initial state differs and clusters path-varying failures", async () => {
    const report = await executeScenarioStability({
      plan: plan("isolation"),
      targets: [
        {
          scenarioId: "read-inbox",
          model: { provider: "test-provider", model: "best-case" },
        },
      ],
      budgets: {
        timeoutMs: 1_000,
        maxInputTokens: 100,
        maxOutputTokens: 100,
        maxToolCalls: 3,
      },
      adapter: {
        async execute({ attemptNumber, outputDir, attemptId }) {
          if (attemptNumber === 1) return passingExecution();
          return passingExecution({
            initialStateHash: "c".repeat(64),
            error: `isolation failure in ${outputDir}/${attemptId}`,
            passed: false,
          });
        },
        async terminate() {},
      },
    });

    expect(report.cells[0]).toMatchObject({
      baselineInitialStateHash: INITIAL_HASH,
      tier: "1/3",
    });
    expect(report.cells[0]?.attempts.slice(1)).toEqual([
      expect.objectContaining({ failureClassification: "harness-failure" }),
      expect.objectContaining({ failureClassification: "harness-failure" }),
    ]);
    expect(report.failureClusters).toEqual([
      expect.objectContaining({
        classification: "harness-failure",
        occurrences: 2,
      }),
    ]);
  });
});
