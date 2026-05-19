/**
 * Tests for the RLM trajectory integration module.
 */

import { describe, expect, it } from "vitest";

import { RLMClient } from "../client";
import type { CostEstimate } from "../cost";
import type { CostSummary, TrajectoryWithCosts } from "../trajectory-integration";
import { inferWithLogging, RLMTrajectoryIntegration } from "../trajectory-integration";

// ============================================================================
// Helpers
// ============================================================================

/** Create a client in stub mode (Python not available). */
function createStubClient(): RLMClient {
  return new RLMClient({ pythonPath: "/nonexistent/python" });
}

/** Create a basic trajectory integration instance. */
function createIntegration(agentId = "test-agent"): RLMTrajectoryIntegration {
  return new RLMTrajectoryIntegration({
    client: createStubClient(),
    agentId,
  });
}

/** Create a sample CostEstimate. */
function sampleCost(overrides?: Partial<CostEstimate>): CostEstimate {
  return {
    model: "gpt-5",
    backend: "openai",
    inputTokens: 100,
    outputTokens: 50,
    inputCostUsd: 0.00025,
    outputCostUsd: 0.0005,
    totalCostUsd: 0.00075,
    ...overrides,
  };
}

// ============================================================================
// Construction
// ============================================================================

describe("RLMTrajectoryIntegration", () => {
  describe("Construction", () => {
    it("should create an integration instance", () => {
      const integration = createIntegration();
      expect(integration).toBeInstanceOf(RLMTrajectoryIntegration);
    });

    it("should expose the underlying client", () => {
      const integration = createIntegration();
      expect(integration.getClient()).toBeInstanceOf(RLMClient);
    });

    it("should use default agent ID", () => {
      const integration = new RLMTrajectoryIntegration({
        client: createStubClient(),
      });
      // No direct accessor, but it should not throw
      expect(integration).toBeDefined();
    });

    it("should accept custom agent and scenario IDs", () => {
      const integration = new RLMTrajectoryIntegration({
        client: createStubClient(),
        agentId: "custom-agent",
        scenarioId: "test-scenario",
      });
      expect(integration).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Step-level API
  // --------------------------------------------------------------------------

  describe("startInferenceStep", () => {
    it("should return a step ID", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1");
      expect(typeof stepId).toBe("string");
      expect(stepId.length).toBeGreaterThan(0);
    });

    it("should create a step with correct trajectory ID", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1");
      const step = integration.getStep(stepId);

      expect(step).toBeDefined();
      expect(step?.trajectoryId).toBe("traj-1");
      expect(step?.completed).toBe(false);
      expect(step?.startTime).toBeGreaterThan(0);
      expect(step?.costs).toHaveLength(0);
    });

    it("should accept options", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1", {
        model: "gpt-5",
        modelVersion: "2024-01",
        metadata: { key: "value" },
      });
      const step = integration.getStep(stepId);

      expect(step?.model).toBe("gpt-5");
      expect(step?.modelVersion).toBe("2024-01");
    });

    it("should track multiple steps in the same trajectory", () => {
      const integration = createIntegration();
      integration.startInferenceStep("traj-1");
      integration.startInferenceStep("traj-1");
      integration.startInferenceStep("traj-1");

      const summary = integration.getCostSummary("traj-1");
      expect(summary.stepCount).toBe(3);
    });
  });

  describe("completeInferenceStep", () => {
    it("should mark step as completed", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1");

      const mockResult = {
        text: "Test response",
        metadata: { stub: true },
      };
      integration.completeInferenceStep(stepId, mockResult);

      const step = integration.getStep(stepId);
      expect(step?.completed).toBe(true);
      expect(step?.endTime).toBeGreaterThan(0);
      expect(step?.result).toEqual(mockResult);
    });

    it("should throw for unknown step", () => {
      const integration = createIntegration();
      expect(() => {
        integration.completeInferenceStep("nonexistent", {
          text: "",
          metadata: { stub: true },
        });
      }).toThrow("Unknown step");
    });
  });

  // --------------------------------------------------------------------------
  // Cost tracking
  // --------------------------------------------------------------------------

  describe("logCost", () => {
    it("should attach cost to a step", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1");

      integration.logCost(stepId, sampleCost());

      const step = integration.getStep(stepId);
      expect(step?.costs).toHaveLength(1);
      expect(step?.costs[0].totalCostUsd).toBeCloseTo(0.00075, 5);
    });

    it("should allow multiple costs per step", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-1");

      integration.logCost(stepId, sampleCost({ totalCostUsd: 0.001 }));
      integration.logCost(stepId, sampleCost({ totalCostUsd: 0.002 }));

      const step = integration.getStep(stepId);
      expect(step?.costs).toHaveLength(2);
    });

    it("should throw for unknown step", () => {
      const integration = createIntegration();
      expect(() => {
        integration.logCost("nonexistent", sampleCost());
      }).toThrow("Unknown step");
    });
  });

  // --------------------------------------------------------------------------
  // Cost summary
  // --------------------------------------------------------------------------

  describe("getCostSummary", () => {
    it("should aggregate costs across steps", () => {
      const integration = createIntegration();

      const step1 = integration.startInferenceStep("traj-1");
      integration.logCost(
        step1,
        sampleCost({ inputTokens: 100, outputTokens: 50, totalCostUsd: 0.003 }),
      );

      const step2 = integration.startInferenceStep("traj-1");
      integration.logCost(
        step2,
        sampleCost({
          inputTokens: 200,
          outputTokens: 100,
          totalCostUsd: 0.009,
        }),
      );

      const summary: CostSummary = integration.getCostSummary("traj-1");
      expect(summary.trajectoryId).toBe("traj-1");
      expect(summary.stepCount).toBe(2);
      expect(summary.totalInputTokens).toBe(300);
      expect(summary.totalOutputTokens).toBe(150);
      expect(summary.totalCostUsd).toBeCloseTo(0.012, 5);
      expect(summary.costs).toHaveLength(2);
    });

    it("should return empty summary for unknown trajectory", () => {
      const integration = createIntegration();
      const summary = integration.getCostSummary("nonexistent");

      expect(summary.stepCount).toBe(0);
      expect(summary.totalInputTokens).toBe(0);
      expect(summary.totalOutputTokens).toBe(0);
      expect(summary.totalCostUsd).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Export
  // --------------------------------------------------------------------------

  describe("exportTrajectoryWithCosts", () => {
    it("should export in-progress trajectory", () => {
      const integration = createIntegration("test-agent");
      integration.startInferenceStep("traj-export");

      const exported: TrajectoryWithCosts = integration.exportTrajectoryWithCosts("traj-export");

      expect(exported.trajectoryId).toBe("traj-export");
      expect(exported.agentId).toBe("test-agent");
      expect(exported.status).toBe("in_progress");
      expect(exported.steps).toHaveLength(1);
      expect(exported.costSummary).toBeDefined();
    });

    it("should export completed trajectory", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-complete");

      integration.completeInferenceStep(stepId, {
        text: "done",
        metadata: { stub: true },
      });

      const exported = integration.exportTrajectoryWithCosts("traj-complete");
      expect(exported.status).toBe("completed");
    });

    it("should export error trajectory", () => {
      const integration = createIntegration();
      const stepId = integration.startInferenceStep("traj-error");

      integration.completeInferenceStep(stepId, {
        text: "",
        metadata: { stub: false, error: "test error" },
      });

      const exported = integration.exportTrajectoryWithCosts("traj-error");
      expect(exported.status).toBe("error");
    });

    it("should include scenario ID if set", () => {
      const integration = new RLMTrajectoryIntegration({
        client: createStubClient(),
        scenarioId: "my-scenario",
      });
      integration.startInferenceStep("traj-scenario");

      const exported = integration.exportTrajectoryWithCosts("traj-scenario");
      expect(exported.scenarioId).toBe("my-scenario");
    });

    it("should return empty trajectory for unknown ID", () => {
      const integration = createIntegration();
      const exported = integration.exportTrajectoryWithCosts("nonexistent");

      expect(exported.steps).toHaveLength(0);
      expect(exported.status).toBe("in_progress");
    });
  });

  // --------------------------------------------------------------------------
  // High-level infer
  // --------------------------------------------------------------------------

  describe("infer", () => {
    it("should perform inference and track trajectory", async () => {
      const integration = createIntegration();
      const result = await integration.infer("test prompt");

      expect(result).toBeDefined();
      expect(result.text).toBeDefined();
      expect(result.metadata.stub).toBe(true);

      // Should have created a trajectory
      const trajectoryIds = integration.getTrajectoryIds();
      expect(trajectoryIds.length).toBeGreaterThan(0);

      // Should have cost data
      const summary = integration.getCostSummary(trajectoryIds[0]);
      expect(summary.stepCount).toBe(1);
    });

    it("should fire onTrajectoryComplete callback", async () => {
      const integration = createIntegration();
      let capturedTrajectory: TrajectoryWithCosts | null = null;

      integration.onTrajectoryComplete((traj) => {
        capturedTrajectory = traj;
      });

      await integration.infer("test prompt");

      expect(capturedTrajectory).not.toBeNull();
      expect(capturedTrajectory?.steps.length).toBeGreaterThan(0);
    });

    it("should pass infer options to client", async () => {
      const integration = createIntegration();
      const result = await integration.infer("test prompt", {
        inferOptions: {
          maxIterations: 10,
          rootModel: "gpt-5",
        },
      });

      expect(result).toBeDefined();
      expect(result.metadata.stub).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  describe("Utilities", () => {
    it("should track trajectory IDs", () => {
      const integration = createIntegration();
      integration.startInferenceStep("traj-a");
      integration.startInferenceStep("traj-b");

      const ids = integration.getTrajectoryIds();
      expect(ids).toContain("traj-a");
      expect(ids).toContain("traj-b");
    });

    it("should clear all tracked data", () => {
      const integration = createIntegration();
      integration.startInferenceStep("traj-1");
      integration.startInferenceStep("traj-2");

      expect(integration.getTrajectoryIds().length).toBe(2);

      integration.clear();
      expect(integration.getTrajectoryIds().length).toBe(0);
    });
  });
});

// ============================================================================
// inferWithLogging
// ============================================================================

describe("inferWithLogging", () => {
  it("should perform one-off inference with logging", async () => {
    const client = createStubClient();
    const result = await inferWithLogging(client, "test prompt");

    expect(result).toBeDefined();
    expect(result.text).toBeDefined();
    expect(result.metadata.stub).toBe(true);
  });

  it("should accept custom agent ID", async () => {
    const client = createStubClient();
    const result = await inferWithLogging(client, "test prompt", {
      agentId: "custom-agent",
    });

    expect(result).toBeDefined();
  });
});
