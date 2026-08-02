/**
 * Model-usage capture tests use real AgentRuntime event dispatch to prove
 * request-local accounting under concurrent and nested asynchronous turns.
 */

import { AgentRuntime, EventType, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { withModelUsageCapture } from "./prompt-optimization.ts";

function createRuntime(): AgentRuntime {
  return new AgentRuntime({ logLevel: "fatal" });
}

async function emitUsage(
  runtime: AgentRuntime,
  provider: string,
  prompt: number,
  completion: number,
): Promise<void> {
  await runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    provider,
    type: ModelType.TEXT_LARGE,
    tokens: {
      prompt,
      completion,
      total: prompt + completion,
    },
  });
}

describe("withModelUsageCapture", () => {
  it("normalizes SDK cache tokens and aggregates every model call", async () => {
    const runtime = createRuntime();

    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "openai",
        model: "gpt-test",
        type: ModelType.TEXT_LARGE,
        tokens: {
          prompt: 80,
          completion: 20,
          total: 100,
          cached: 64,
        },
      });
      await runtime.emitEvent([EventType.MODEL_USED], {
        runtime,
        source: "anthropic",
        modelName: "claude-test",
        type: ModelType.TEXT_LARGE,
        usageEstimated: true,
        tokens: {
          prompt: 40,
          total: 50,
          cache_creation_input_tokens: 12,
        },
      });
      return "complete";
    });

    expect(captured).toEqual({
      result: "complete",
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cacheReadInputTokens: 64,
        cacheCreationInputTokens: 12,
        cachedInputTokens: 64,
        model: "claude-test",
        provider: "anthropic",
        isEstimated: true,
        llmCalls: 2,
      },
    });
  });

  it("isolates overlapping turns on the same runtime", async () => {
    const runtime = createRuntime();
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });

    const capture = async (
      provider: string,
      prompt: number,
      completion: number,
    ) =>
      withModelUsageCapture(runtime, async () => {
        arrived += 1;
        if (arrived === 2) release();
        await bothArrived;
        await emitUsage(runtime, provider, prompt, completion);
        return provider;
      });

    const [first, second] = await Promise.all([
      capture("provider-a", 101, 11),
      capture("provider-b", 202, 22),
    ]);

    expect(first).toMatchObject({
      result: "provider-a",
      usage: {
        promptTokens: 101,
        completionTokens: 11,
        totalTokens: 112,
        provider: "provider-a",
        llmCalls: 1,
      },
    });
    expect(second).toMatchObject({
      result: "provider-b",
      usage: {
        promptTokens: 202,
        completionTokens: 22,
        totalTokens: 224,
        provider: "provider-b",
        llmCalls: 1,
      },
    });
  });

  it("includes nested calls in the outer capture without leaking outward", async () => {
    const runtime = createRuntime();

    const outer = await withModelUsageCapture(runtime, async () => {
      await emitUsage(runtime, "outer-before", 10, 1);
      const inner = await withModelUsageCapture(runtime, async () => {
        await emitUsage(runtime, "inner", 20, 2);
        return "inner-result";
      });
      await emitUsage(runtime, "outer-after", 30, 3);
      return inner;
    });

    expect(outer.result).toMatchObject({
      result: "inner-result",
      usage: {
        promptTokens: 20,
        completionTokens: 2,
        totalTokens: 22,
        provider: "inner",
        llmCalls: 1,
      },
    });
    expect(outer.usage).toMatchObject({
      promptTokens: 60,
      completionTokens: 6,
      totalTokens: 66,
      provider: "outer-after",
      llmCalls: 3,
    });

    const subsequent = await withModelUsageCapture(runtime, async () => "next");
    expect(subsequent).toEqual({ result: "next", usage: null });
  });

  it("ignores model events that contain no usage fields", async () => {
    const runtime = createRuntime();

    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "empty",
        type: ModelType.TEXT_LARGE,
        tokens: {},
      });
    });

    expect(captured.usage).toBeNull();
  });

  it("does not mislabel a logical model slot as a concrete billable model", async () => {
    const runtime = createRuntime();

    const captured = await withModelUsageCapture(runtime, async () => {
      await runtime.emitEvent(EventType.MODEL_USED, {
        runtime,
        provider: "cerebras",
        type: ModelType.RESPONSE_HANDLER,
        tokens: {
          prompt: 10,
          completion: 2,
          total: 12,
        },
      });
    });

    expect(captured.usage).toMatchObject({
      provider: "cerebras",
      promptTokens: 10,
      completionTokens: 2,
      llmCalls: 1,
    });
    expect(captured.usage).not.toHaveProperty("model");
  });

  it("propagates request failures and leaves the next capture clean", async () => {
    const runtime = createRuntime();

    await expect(
      withModelUsageCapture(runtime, async () => {
        await emitUsage(runtime, "failed-turn", 99, 9);
        throw new Error("request failed");
      }),
    ).rejects.toThrow("request failed");

    const next = await withModelUsageCapture(runtime, async () => {
      await emitUsage(runtime, "next-turn", 7, 3);
      return "ok";
    });
    expect(next).toMatchObject({
      result: "ok",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        provider: "next-turn",
        llmCalls: 1,
      },
    });
  });
});
