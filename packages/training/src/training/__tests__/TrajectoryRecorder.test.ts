/**
 * TrajectoryRecorder Tests
 *
 * REAL tests that exercise the actual TrajectoryRecorder class.
 * Uses simulation mode to avoid database dependency.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { setSimulationMode, TrajectoryRecorder } from "../TrajectoryRecorder";
import type { Action, EnvironmentState, LLMCall } from "../types";

// =============================================================================
// Test Setup
// =============================================================================

const TEST_OUTPUT_DIR = "./training-data-output/trajectories";

describe("TrajectoryRecorder - Real Class Tests", () => {
  let recorder: TrajectoryRecorder;

  beforeEach(() => {
    setSimulationMode(true);
    recorder = new TrajectoryRecorder();
    // Clean up test output
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      const files = fs.readdirSync(TEST_OUTPUT_DIR);
      for (const file of files) {
        if (file.startsWith("test-")) {
          fs.unlinkSync(path.join(TEST_OUTPUT_DIR, file));
        }
      }
    }
  });

  afterEach(() => {
    setSimulationMode(false);
    // Cleanup after each test
    if (fs.existsSync(TEST_OUTPUT_DIR)) {
      const files = fs.readdirSync(TEST_OUTPUT_DIR);
      for (const file of files) {
        if (file.includes("test-agent")) {
          try {
            fs.unlinkSync(path.join(TEST_OUTPUT_DIR, file));
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }
  });

  // ===========================================================================
  // Lifecycle Tests
  // ===========================================================================

  test("startTrajectory creates a new active trajectory", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent-1",
      archetype: "trader",
    });

    expect(trajectoryId).toBeDefined();
    expect(typeof trajectoryId).toBe("string");
    expect(trajectoryId.length).toBeGreaterThan(10);
    expect(recorder.isActive(trajectoryId)).toBe(true);
    expect(recorder.getActiveCount()).toBe(1);
  });

  test("multiple trajectories can be active simultaneously", async () => {
    const id1 = await recorder.startTrajectory({ agentId: "test-agent-1" });
    const id2 = await recorder.startTrajectory({ agentId: "test-agent-2" });
    const id3 = await recorder.startTrajectory({ agentId: "test-agent-3" });

    expect(recorder.getActiveCount()).toBe(3);
    expect(recorder.isActive(id1)).toBe(true);
    expect(recorder.isActive(id2)).toBe(true);
    expect(recorder.isActive(id3)).toBe(true);
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
  });

  test("getActiveTrajectory returns correct trajectory", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent-x",
      archetype: "degen",
      scenarioId: "test-scenario",
    });

    const active = recorder.getActiveTrajectory(trajectoryId);

    expect(active).toBeDefined();
    expect(active?.agentId).toBe("test-agent-x");
    expect(active?.archetype).toBe("degen");
    expect(active?.scenarioId).toBe("test-scenario");
    expect(active?.steps).toHaveLength(0);
  });

  test("getActiveTrajectory returns undefined for non-existent id", () => {
    const result = recorder.getActiveTrajectory("non-existent-id");
    expect(result).toBeUndefined();
  });

  // ===========================================================================
  // Step Recording Tests
  // ===========================================================================

  test("startStep initializes current step with environment state", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });

    const envState: EnvironmentState = {
      agentBalance: 10000,
      agentPnL: 0,
      openPositions: 0,
    };

    recorder.startStep(trajectoryId, envState);

    const active = recorder.getActiveTrajectory(trajectoryId);
    expect(active?.currentStep).toBeDefined();
    expect(active?.currentStep?.environmentState).toEqual(envState);
    expect(active?.currentStep?.stepNumber).toBe(0);
  });

  test("startStep throws for non-existent trajectory", () => {
    expect(() => {
      recorder.startStep("fake-id", {
        agentBalance: 0,
        agentPnL: 0,
        openPositions: 0,
      });
    }).toThrow("Trajectory not found: fake-id");
  });

  test("logProviderAccess adds provider data to current step", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    recorder.startStep(trajectoryId, {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
    });

    recorder.logProviderAccess(trajectoryId, {
      providerName: "market-data",
      data: { ticker: "BTCAI", price: 50000 },
      purpose: "price lookup",
    });

    const active = recorder.getActiveTrajectory(trajectoryId);
    expect(active?.currentStep?.providerAccesses).toHaveLength(1);
    expect(active?.currentStep?.providerAccesses?.[0]?.providerName).toBe(
      "market-data",
    );
  });

  test("logProviderAccess throws when no current step", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    // Don't call startStep

    expect(() => {
      recorder.logProviderAccess(trajectoryId, {
        providerName: "test",
        data: {},
        purpose: "test",
      });
    }).toThrow("No current step");
  });

  test("logLLMCall adds LLM call to current step", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    recorder.startStep(trajectoryId, {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
    });

    const llmCall: LLMCall = {
      model: "qwen-32b",
      systemPrompt: "You are a trading agent",
      userPrompt: "What should I do?",
      response: "Buy BTCAI",
      reasoning: "Bullish momentum",
      temperature: 0.7,
      maxTokens: 2000,
      purpose: "action",
      latencyMs: 250,
    };

    recorder.logLLMCall(trajectoryId, llmCall);

    const active = recorder.getActiveTrajectory(trajectoryId);
    expect(active?.currentStep?.llmCalls).toHaveLength(1);
    expect(active?.currentStep?.llmCalls?.[0]?.model).toBe("qwen-32b");
    expect(active?.currentStep?.llmCalls?.[0]?.latencyMs).toBe(250);
  });

  test("completeStep finalizes step and adds to trajectory", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    recorder.startStep(trajectoryId, {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
    });

    const action: Action = {
      actionType: "buy",
      parameters: { ticker: "BTCAI", amount: 100 },
      success: true,
    };

    recorder.completeStep(trajectoryId, action, 0.5);

    const active = recorder.getActiveTrajectory(trajectoryId);
    expect(active?.steps).toHaveLength(1);
    expect(active?.steps[0]?.action.actionType).toBe("buy");
    expect(active?.steps[0]?.reward).toBe(0.5);
    expect(active?.currentStep).toBeUndefined();
  });

  test("multiple steps increment step number correctly", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });

    for (let i = 0; i < 5; i++) {
      recorder.startStep(trajectoryId, {
        agentBalance: 1000 - i * 100,
        agentPnL: i * 10,
        openPositions: i,
      });
      recorder.completeStep(
        trajectoryId,
        { actionType: "hold", parameters: {}, success: true },
        0.1,
      );
    }

    const active = recorder.getActiveTrajectory(trajectoryId);
    expect(active?.steps).toHaveLength(5);
    expect(active?.steps[0]?.stepNumber).toBe(0);
    expect(active?.steps[4]?.stepNumber).toBe(4);
  });

  // ===========================================================================
  // End Trajectory Tests (Simulation Mode - File Output)
  // ===========================================================================

  test("endTrajectory saves JSON file in simulation mode", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent-file",
      archetype: "trader",
    });

    // Add a step
    recorder.startStep(trajectoryId, {
      agentBalance: 10000,
      agentPnL: 0,
      openPositions: 0,
    });
    recorder.logLLMCall(trajectoryId, {
      model: "test-model",
      systemPrompt: "system",
      userPrompt: "user",
      response: "response",
      temperature: 0.5,
      maxTokens: 100,
      purpose: "action",
    });
    recorder.completeStep(
      trajectoryId,
      { actionType: "buy", parameters: { ticker: "BTCAI" }, success: true },
      1.0,
    );

    await recorder.endTrajectory(trajectoryId, {
      finalBalance: 10500,
      finalPnL: 500,
    });

    // Verify file was created
    const filePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify file contents
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.trajectory.agentId).toBe("test-agent-file");
    expect(content.trajectory.archetype).toBe("trader");
    expect(content.trajectory.episodeLength).toBe(1);
    expect(content.trajectory.finalBalance).toBe(10500);
    expect(content.trajectory.finalPnL).toBe(500);
    expect(content.llmCalls).toHaveLength(1);

    // Cleanup
    fs.unlinkSync(filePath);
  });

  test("endTrajectory removes trajectory from active map", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    expect(recorder.isActive(trajectoryId)).toBe(true);

    await recorder.endTrajectory(trajectoryId);

    expect(recorder.isActive(trajectoryId)).toBe(false);
    expect(recorder.getActiveCount()).toBe(0);
  });

  test("endTrajectory throws for non-existent trajectory", async () => {
    await expect(recorder.endTrajectory("fake-id")).rejects.toThrow(
      "Trajectory not found: fake-id",
    );
  });

  test("endTrajectory calculates metrics correctly", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });

    // Add buy action
    recorder.startStep(trajectoryId, {
      agentBalance: 10000,
      agentPnL: 0,
      openPositions: 0,
    });
    recorder.completeStep(
      trajectoryId,
      { actionType: "BUY_YES", parameters: {}, success: true },
      1.0,
    );

    // Add sell action
    recorder.startStep(trajectoryId, {
      agentBalance: 9000,
      agentPnL: 100,
      openPositions: 1,
    });
    recorder.completeStep(
      trajectoryId,
      { actionType: "SELL", parameters: {}, success: true },
      0.5,
    );

    // Add failed action
    recorder.startStep(trajectoryId, {
      agentBalance: 9500,
      agentPnL: 150,
      openPositions: 0,
    });
    recorder.completeStep(
      trajectoryId,
      {
        actionType: "BUY_NO",
        parameters: {},
        success: false,
        error: "Insufficient funds",
      },
      -0.5,
    );

    await recorder.endTrajectory(trajectoryId);

    // Check that file was written with correct metrics
    const filePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(content.trajectory.episodeLength).toBe(3);
    expect(content.trajectory.tradesExecuted).toBe(3); // BUY_YES, SELL, BUY_NO
    expect(content.trajectory.totalReward).toBe(1.0); // 1.0 + 0.5 + (-0.5)
    expect(content.trajectory.finalStatus).toBe("completed_with_errors");

    fs.unlinkSync(filePath);
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  test("handles trajectory with zero steps", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });

    await recorder.endTrajectory(trajectoryId);

    const filePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(content.trajectory.episodeLength).toBe(0);
    expect(content.trajectory.totalReward).toBe(0);
    expect(content.llmCalls).toHaveLength(0);

    fs.unlinkSync(filePath);
  });

  test("handles very long prompts in LLM calls", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });
    recorder.startStep(trajectoryId, {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
    });

    const longPrompt = "A".repeat(50000); // 50k characters

    recorder.logLLMCall(trajectoryId, {
      model: "test",
      systemPrompt: longPrompt,
      userPrompt: longPrompt,
      response: longPrompt,
      temperature: 0.5,
      maxTokens: 100,
      purpose: "action",
    });

    recorder.completeStep(
      trajectoryId,
      { actionType: "hold", parameters: {}, success: true },
      0,
    );

    await recorder.endTrajectory(trajectoryId);

    const filePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.llmCalls[0].systemPrompt.length).toBe(50000);

    fs.unlinkSync(filePath);
  });

  test("handles negative rewards correctly", async () => {
    const trajectoryId = await recorder.startTrajectory({
      agentId: "test-agent",
    });

    recorder.startStep(trajectoryId, {
      agentBalance: 1000,
      agentPnL: 0,
      openPositions: 0,
    });
    recorder.completeStep(
      trajectoryId,
      { actionType: "buy", parameters: {}, success: false, error: "Bad trade" },
      -5.0,
    );

    await recorder.endTrajectory(trajectoryId);

    const filePath = path.join(TEST_OUTPUT_DIR, `${trajectoryId}.json`);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

    expect(content.trajectory.totalReward).toBe(-5.0);

    fs.unlinkSync(filePath);
  });
});
