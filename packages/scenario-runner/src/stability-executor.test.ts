/** Exercises strict three-attempt execution with a real synthetic world and a fake paid-model boundary. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SyntheticWorld } from "@elizaos/synthetic-world";
import { testManifest } from "@elizaos/synthetic-world/test-fixture";
import { afterEach, describe, expect, it } from "vitest";
import { createScenarioStabilityPlan } from "./stability.ts";
import { executeScenarioStabilityMatrix } from "./stability-executor.ts";

const DIGEST = "a".repeat(64);

function resetProof(
  overrides: Partial<
    import("./stability-executor.ts").StabilityResetProof
  > = {},
) {
  return {
    schemaVersion: "eliza.synthetic-reset-proof/v1" as const,
    resetId: "test-reset",
    generation: 1,
    manifestHash: DIGEST,
    executionStateHash: DIGEST,
    providerStateHash: DIGEST,
    modelRegistryHash: DIGEST,
    ...overrides,
  };
}

describe("scenario stability executor", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  it("runs all three isolated attempts and records model/provider evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stability-executor-"));
    roots.push(root);
    const world = new SyntheticWorld(testManifest(), `stability-${Date.now()}`);
    const calls: number[] = [];
    try {
      const matrix = await executeScenarioStabilityMatrix({
        plan: createScenarioStabilityPlan({
          runId: "paid-model",
          outputRoot: root,
        }),
        targets: [
          {
            scenarioId: "message-route",
            model: { provider: "fake-paid", model: "best-case-v1" },
          },
        ],
        budgets: {
          timeoutMs: 1_000,
          maxInputTokens: 100,
          maxOutputTokens: 100,
          maxToolCalls: 3,
        },
        adapter: {
          async reset({ attemptNumber }) {
            world.reset();
            calls.push(attemptNumber);
            return resetProof({
              resetId: `test-reset-${attemptNumber}`,
              generation: attemptNumber,
              executionStateHash: world.executionStateHash,
              providerStateHash: world.stateHash,
            });
          },
          async execute({ target, attemptNumber }) {
            const receipt = await world.executeBoundary("paid-model.generate", {
              input: { scenarioId: target.scenarioId, attemptNumber },
              execute: () => ({ text: "best-case answer" }),
            });
            return {
              passed: true,
              inputTokens: 8,
              outputTokens: 3,
              toolCalls: 1,
              finalExecutionStateHash: world.executionStateHash,
              stateDiff: world.ledger.snapshot().entries,
              evidence: {
                trajectory: [{ stage: "model", receipt }],
                toolReceipts: [{ tool: "paid-model.generate" }],
                stateTransitions: world.ledger.snapshot().entries,
                providerReceipts: [{ provider: target.model.provider }],
                judgeVerdicts: [{ passed: true, score: 1 }],
              },
            };
          },
          async terminate() {},
        },
      });
      expect(calls).toEqual([1, 2, 3]);
      expect(matrix.status).toBe("passed");
      expect(matrix.cells[0]).toMatchObject({ passedAttempts: 3, tier: "3/3" });
      expect(
        new Set(matrix.cells[0]?.attempts.map((item) => item.outputDir)).size,
      ).toBe(3);
    } finally {
      world.teardown();
    }
  });

  it("fails on reset leakage, budgets, timeout, and any result below three of three", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "stability-executor-fail-"));
    roots.push(root);
    const plan = createScenarioStabilityPlan({
      runId: "strict-fail",
      outputRoot: root,
    });
    let attempt = 0;
    const matrix = await executeScenarioStabilityMatrix({
      plan,
      targets: [
        { scenarioId: "alpha", model: { provider: "fake", model: "v1" } },
      ],
      budgets: {
        timeoutMs: 100,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 1,
      },
      adapter: {
        async reset() {
          attempt += 1;
          return resetProof({
            resetId: `test-reset-${attempt}`,
            generation: attempt,
          });
        },
        async execute() {
          return {
            passed: attempt !== 2,
            inputTokens: 1,
            outputTokens: 1,
            toolCalls: 0,
            finalExecutionStateHash: "same",
            stateDiff: null,
            evidence: {
              trajectory: [],
              toolReceipts: [],
              stateTransitions: [],
              providerReceipts: [],
              judgeVerdicts: [],
            },
          };
        },
        async terminate() {},
      },
    });
    expect(matrix.status).toBe("failed");
    expect(matrix.cells[0]).toMatchObject({ tier: "2/3", strictPassed: false });
    expect(matrix.failureClusters).toEqual([
      expect.objectContaining({
        classification: "scenario-failure",
        occurrences: 1,
      }),
    ]);
  });

  it("records reset leakage, budget overflow, and cancelled timeouts without skipping later attempts", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "stability-executor-adversarial-"),
    );
    roots.push(root);
    const terminated: string[] = [];
    const matrix = await executeScenarioStabilityMatrix({
      plan: createScenarioStabilityPlan({
        runId: "adversarial",
        outputRoot: root,
      }),
      targets: [
        { scenarioId: "leak", model: { provider: "fake", model: "v1" } },
        { scenarioId: "budget", model: { provider: "fake", model: "v1" } },
        { scenarioId: "timeout", model: { provider: "fake", model: "v1" } },
      ],
      budgets: {
        timeoutMs: 20,
        maxInputTokens: 10,
        maxOutputTokens: 10,
        maxToolCalls: 1,
      },
      adapter: {
        async reset({ target, attemptNumber }) {
          return resetProof({
            resetId: `${target.scenarioId}-${attemptNumber}`,
            generation: attemptNumber,
            executionStateHash:
              target.scenarioId === "leak" && attemptNumber === 2
                ? "b".repeat(64)
                : DIGEST,
          });
        },
        async execute({ target, attemptId, signal }) {
          if (target.scenarioId === "timeout") {
            await new Promise<void>((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              }),
            );
          }
          return {
            passed: true,
            inputTokens: target.scenarioId === "budget" ? 11 : 1,
            outputTokens: 1,
            toolCalls: 0,
            finalExecutionStateHash: "after",
            stateDiff: [],
            evidence: {
              trajectory: [{ attemptId }],
              toolReceipts: [],
              stateTransitions: [],
              providerReceipts: [],
              judgeVerdicts: [],
            },
          };
        },
        async terminate({ target, attemptNumber }) {
          terminated.push(`${target.scenarioId}:${attemptNumber}`);
        },
      },
    });
    expect(terminated).toHaveLength(9);
    expect(matrix.cells.map((cell) => [cell.scenarioId, cell.tier])).toEqual([
      ["leak", "2/3"],
      ["budget", "0/3"],
      ["timeout", "0/3"],
    ]);
    expect(
      matrix.cells.every((cell) =>
        cell.failureClassifications.includes("harness-failure"),
      ),
    ).toBe(true);
  });
});
