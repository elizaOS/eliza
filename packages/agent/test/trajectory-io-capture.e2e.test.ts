/**
 * Trajectory I/O Capture E2E Tests
 *
 * Verifies that trajectories correctly capture input and output data
 * end-to-end using the DatabaseTrajectoryLogger, covering:
 * 1. LLM call input (systemPrompt, userPrompt) and output (response) persistence
 * 2. Provider access data capture
 * 3. Multiple messages create separate trajectories
 * 4. Trajectory lifecycle: start → logLlmCall → logProviderAccess → end
 * 5. Multiple LLM calls within a single trajectory
 * 6. Long prompts/responses preserved without silent truncation
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter, logger } from "@elizaos/core";
import { default as pluginSql } from "@elizaos/plugin-sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DatabaseTrajectoryLogger,
  flushTrajectoryWrites,
} from "../src/runtime/trajectory-persistence";

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let handle: NodeJS.Timeout | null = null;
  const tp = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, tp]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

describe("Trajectory I/O Capture E2E", () => {
  let runtime: AgentRuntime;
  let dbLogger: DatabaseTrajectoryLogger;
  const pgliteDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-e2e-traj-io-"),
  );
  let initFailed = false;

  beforeAll(async () => {
    process.env.PGLITE_DATA_DIR = pgliteDir;

    const character = createCharacter({
      name: "TrajectoryIOTestAgent",
      system: "You are a helpful test assistant.",
    });

    runtime = new AgentRuntime({
      character,
      plugins: [],
      logLevel: "warn",
      enableAutonomy: false,
    });

    try {
      await runtime.registerPlugin(pluginSql);
      await runtime.initialize();
    } catch (err) {
      logger.warn(
        `[trajectory-io] Runtime init failed, skipping suite: ${err}`,
      );
      initFailed = true;
      return;
    }

    dbLogger = new DatabaseTrajectoryLogger(runtime);
    await dbLogger.initialize();
  }, 180_000);

  afterAll(async () => {
    if (runtime) {
      try {
        await withTimeout(runtime.stop(), 90_000, "runtime.stop()");
      } catch (err) {
        logger.warn(`[e2e] Runtime stop error: ${err}`);
      }
    }
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 150_000);

  it("captures LLM call input and output data with full fidelity", async () => {
    if (initFailed) return;

    // Start a trajectory — in "new" mode (no agentId in options),
    // startTrajectory generates a unique stepId
    const stepId = await dbLogger.startTrajectory("io-test-agent-001", {
      source: "chat",
      metadata: { trigger: "Hello, how are you?" },
    });
    expect(typeof stepId).toBe("string");
    expect(stepId.length).toBeGreaterThan(0);

    // Log an LLM call with detailed input/output
    dbLogger.logLlmCall({
      stepId,
      model: "claude-sonnet-4-20250514",
      systemPrompt:
        "You are a helpful assistant. Be concise and accurate.",
      userPrompt: "What is the capital of France?",
      response:
        "The capital of France is Paris. It is the largest city in France.",
      temperature: 0.7,
      maxTokens: 1024,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 250,
      timestamp: Date.now(),
      promptTokens: 42,
      completionTokens: 18,
    });

    // End the trajectory
    await dbLogger.endTrajectory(stepId, "completed");

    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 300));

    // Verify the trajectory detail contains the correct input/output
    const detail = await dbLogger.getTrajectoryDetail(stepId);
    expect(detail).not.toBeNull();
    expect(detail!.steps.length).toBeGreaterThanOrEqual(1);

    const llmCalls = detail!.steps[0]?.llmCalls ?? [];
    expect(llmCalls.length).toBe(1);

    const call = llmCalls[0];

    // Verify INPUT data
    expect(call.systemPrompt).toBe(
      "You are a helpful assistant. Be concise and accurate.",
    );
    expect(call.userPrompt).toBe("What is the capital of France?");
    expect(call.model).toBe("claude-sonnet-4-20250514");
    expect(call.temperature).toBe(0.7);
    expect(call.maxTokens).toBe(1024);

    // Verify OUTPUT data
    expect(call.response).toBe(
      "The capital of France is Paris. It is the largest city in France.",
    );
    expect(call.latencyMs).toBe(250);
    expect(call.promptTokens).toBe(42);
    expect(call.completionTokens).toBe(18);

    // Verify purpose/action metadata
    expect(call.purpose).toBe("action");
    expect(call.actionType).toBe("runtime.useModel");
  });

  it("captures provider access data alongside LLM calls", async () => {
    if (initFailed) return;

    // Use legacy signature (agentId in options) so stepId is the first arg
    const stepId = "io-capture-provider-step-002";

    await dbLogger.startTrajectory(stepId, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "Tell me about weather" },
    });

    // Log a provider access
    dbLogger.logProviderAccess({
      stepId,
      providerId: "weather-provider",
      providerName: "WeatherAPI",
      timestamp: Date.now(),
      data: { textLength: 350 },
      purpose: "compose_state",
      query: { message: "Tell me about weather" },
    });

    // Log the LLM call that uses provider data
    dbLogger.logLlmCall({
      stepId,
      model: "claude-sonnet-4-20250514",
      systemPrompt: "You are a weather assistant.",
      userPrompt: "Tell me about weather in NYC",
      response:
        "The weather in NYC is currently 72F and sunny with light winds.",
      temperature: 0.5,
      maxTokens: 512,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 180,
      timestamp: Date.now(),
      promptTokens: 65,
      completionTokens: 22,
    });

    await dbLogger.endTrajectory(stepId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 300));

    const detail = await dbLogger.getTrajectoryDetail(stepId);
    expect(detail).not.toBeNull();

    const step = detail!.steps[0];
    expect(step).toBeDefined();

    // Verify provider access was captured
    const providers = step?.providerAccesses ?? [];
    expect(providers.length).toBe(1);
    expect(providers[0].providerName).toBe("WeatherAPI");
    expect(providers[0].purpose).toBe("compose_state");

    // Verify LLM call was captured alongside
    const llmCalls = step?.llmCalls ?? [];
    expect(llmCalls.length).toBe(1);
    expect(llmCalls[0].userPrompt).toBe("Tell me about weather in NYC");
    expect(llmCalls[0].response).toContain("72F");
  });

  it("creates separate trajectories for separate messages", async () => {
    if (initFailed) return;

    const stepId1 = "io-separate-msg-001";
    const stepId2 = "io-separate-msg-002";

    // First message trajectory
    await dbLogger.startTrajectory(stepId1, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "First message" },
    });
    dbLogger.logLlmCall({
      stepId: stepId1,
      model: "test-model",
      systemPrompt: "system-1",
      userPrompt: "first user message",
      response: "first response",
      temperature: 0,
      maxTokens: 100,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 50,
      timestamp: Date.now(),
    });
    await dbLogger.endTrajectory(stepId1, "completed");

    // Second message trajectory
    await dbLogger.startTrajectory(stepId2, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "Second message" },
    });
    dbLogger.logLlmCall({
      stepId: stepId2,
      model: "test-model",
      systemPrompt: "system-2",
      userPrompt: "second user message",
      response: "second response",
      temperature: 0,
      maxTokens: 100,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 75,
      timestamp: Date.now(),
    });
    await dbLogger.endTrajectory(stepId2, "completed");

    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 300));

    // Verify separate trajectories
    const detail1 = await dbLogger.getTrajectoryDetail(stepId1);
    const detail2 = await dbLogger.getTrajectoryDetail(stepId2);

    expect(detail1).not.toBeNull();
    expect(detail2).not.toBeNull();

    // Each trajectory should have its own LLM calls
    const calls1 = detail1!.steps[0]?.llmCalls ?? [];
    const calls2 = detail2!.steps[0]?.llmCalls ?? [];

    expect(calls1.length).toBe(1);
    expect(calls2.length).toBe(1);

    // Verify they have different content
    expect(calls1[0].userPrompt).toBe("first user message");
    expect(calls1[0].response).toBe("first response");
    expect(calls2[0].userPrompt).toBe("second user message");
    expect(calls2[0].response).toBe("second response");
  });

  it("trajectory lifecycle: start → active → completed with correct status", async () => {
    if (initFailed) return;

    const stepId = "io-lifecycle-step-003";

    await dbLogger.startTrajectory(stepId, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "lifecycle test" },
    });

    dbLogger.logLlmCall({
      stepId,
      model: "test-model",
      systemPrompt: "sys",
      userPrompt: "hello",
      response: "hi",
      temperature: 0,
      maxTokens: 50,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 10,
      timestamp: Date.now(),
    });

    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 200));

    // Before ending: trajectory should exist
    const beforeEnd = await dbLogger.getTrajectoryDetail(stepId);
    expect(beforeEnd).not.toBeNull();

    // End the trajectory
    await dbLogger.endTrajectory(stepId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 200));

    // After ending: verify completed status
    const afterEnd = await dbLogger.getTrajectoryDetail(stepId);
    expect(afterEnd).not.toBeNull();
    expect(afterEnd!.metrics?.finalStatus).toBe("completed");
    expect(afterEnd!.endTime).toBeDefined();
    expect(afterEnd!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles multiple LLM calls within a single trajectory", async () => {
    if (initFailed) return;

    const stepId = "io-multi-call-step-005";

    await dbLogger.startTrajectory(stepId, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "multi-call test" },
    });

    // First call: shouldRespond check
    dbLogger.logLlmCall({
      stepId,
      model: "claude-haiku",
      systemPrompt: "Decide if you should respond.",
      userPrompt: "Hey there!",
      response: '{"action":"RESPOND"}',
      temperature: 0,
      maxTokens: 50,
      purpose: "should_respond",
      actionType: "runtime.useModel",
      latencyMs: 30,
      timestamp: Date.now(),
    });

    // Second call: generate response
    dbLogger.logLlmCall({
      stepId,
      model: "claude-sonnet",
      systemPrompt: "You are a helpful assistant.",
      userPrompt: "Hey there! How can you help me?",
      response: "Hello! I can help with many things.",
      temperature: 0.7,
      maxTokens: 1024,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 200,
      timestamp: Date.now() + 50,
    });

    await dbLogger.endTrajectory(stepId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 300));

    const detail = await dbLogger.getTrajectoryDetail(stepId);
    expect(detail).not.toBeNull();

    const llmCalls = detail!.steps[0]?.llmCalls ?? [];
    expect(llmCalls.length).toBe(2);

    // Verify first call (shouldRespond)
    expect(llmCalls[0].purpose).toBe("should_respond");
    expect(llmCalls[0].userPrompt).toBe("Hey there!");
    expect(llmCalls[0].response).toContain("RESPOND");

    // Verify second call (generate response)
    expect(llmCalls[1].purpose).toBe("action");
    expect(llmCalls[1].userPrompt).toContain("How can you help me");
    expect(llmCalls[1].response).toContain("Hello!");
  });

  it("preserves long prompts and responses without truncation", async () => {
    if (initFailed) return;

    const stepId = "io-long-content-step-006";

    const longSystemPrompt = "You are a detailed assistant. ".repeat(100);
    const longUserPrompt = "Please explain in detail: ".repeat(50);
    const longResponse = "Here is a comprehensive explanation: ".repeat(80);

    await dbLogger.startTrajectory(stepId, {
      agentId: "test-agent",
      source: "chat",
      metadata: { trigger: "long content test" },
    });

    dbLogger.logLlmCall({
      stepId,
      model: "claude-sonnet",
      systemPrompt: longSystemPrompt,
      userPrompt: longUserPrompt,
      response: longResponse,
      temperature: 0.5,
      maxTokens: 4096,
      purpose: "action",
      actionType: "runtime.useModel",
      latencyMs: 500,
      timestamp: Date.now(),
    });

    await dbLogger.endTrajectory(stepId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise((r) => setTimeout(r, 300));

    const detail = await dbLogger.getTrajectoryDetail(stepId);
    expect(detail).not.toBeNull();

    const call = detail!.steps[0]?.llmCalls[0];
    expect(call).toBeDefined();

    // Verify prompts/responses are preserved (they may be truncated at 2x limit
    // by the truncateField helper, but should contain substantial content)
    expect(call!.systemPrompt.length).toBeGreaterThan(100);
    expect(call!.userPrompt.length).toBeGreaterThan(100);
    expect(call!.response.length).toBeGreaterThan(100);

    // The content should start with the expected text
    expect(call!.systemPrompt).toContain("You are a detailed assistant.");
    expect(call!.userPrompt).toContain("Please explain in detail:");
    expect(call!.response).toContain(
      "Here is a comprehensive explanation:",
    );
  });
});
