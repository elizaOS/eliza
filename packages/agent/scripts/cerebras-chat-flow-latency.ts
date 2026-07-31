#!/usr/bin/env bun
/**
 * Measures the complete production chat path against Cerebras Gemma 4 31B.
 *
 * A real PGLite-backed AgentRuntime processes every turn through providers,
 * model routing, streaming, persistence, delivery, and lifecycle events. The
 * report retains synthetic prompts and outputs so reviewers can verify that
 * each live response was distinct rather than served by a fabricated fallback.
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  buildInferenceTimingDevPayload,
  ChannelType,
  createMessageMemory,
  drainPostDeliveryTasks,
  EventType,
  type InferenceFlowStage,
  type InferenceHistogramSummary,
  InferenceTurnTimer,
  inferenceTimingRegistry,
  type Memory,
  type ModelEventPayload,
  runWithInferenceTiming,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { generateChatResponse } from "../src/api/chat-routes.ts";

const DEFAULT_MODEL = "gemma-4-31b";
const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 3;

export interface Distribution {
  count: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface ModelUsageEvidence {
  provider: string;
  model: string;
  modelName: string;
  modelLabel?: string;
  type: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    cachedInputTokens?: number;
  };
}

export function modelUsageEvidence(
  payload: ModelEventPayload,
  expectedModel: string,
): ModelUsageEvidence {
  const provider = payload.provider?.trim();
  const model = payload.model?.trim();
  const modelName = payload.modelName?.trim();
  if (provider !== "cerebras") {
    throw new Error(
      `Expected MODEL_USED provider cerebras, received ${JSON.stringify(provider)}`,
    );
  }
  if (model !== expectedModel || modelName !== expectedModel) {
    throw new Error(
      `Expected MODEL_USED model ${expectedModel}, received ${JSON.stringify({
        model,
        modelName,
      })}`,
    );
  }
  const { tokens } = payload;
  if (
    !tokens ||
    !Number.isFinite(tokens.prompt) ||
    !Number.isFinite(tokens.completion) ||
    !Number.isFinite(tokens.total) ||
    tokens.prompt < 0 ||
    tokens.completion < 0 ||
    tokens.total <= 0
  ) {
    throw new Error(
      `MODEL_USED did not report valid provider token usage: ${JSON.stringify(tokens)}`,
    );
  }
  return {
    provider,
    model,
    modelName,
    ...(payload.modelLabel ? { modelLabel: payload.modelLabel } : {}),
    type: String(payload.type),
    tokens: {
      prompt: tokens.prompt,
      completion: tokens.completion,
      total: tokens.total,
      ...(tokens.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: tokens.cacheReadInputTokens }
        : {}),
      ...(tokens.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: tokens.cacheCreationInputTokens }
        : {}),
      ...(tokens.cachedInputTokens !== undefined
        ? { cachedInputTokens: tokens.cachedInputTokens }
        : {}),
    },
  };
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function percentile(
  sortedSamples: readonly number[],
  percent: number,
): number {
  if (sortedSamples.length === 0) {
    throw new Error("Cannot take a percentile of an empty sample");
  }
  const rank = Math.ceil((percent / 100) * sortedSamples.length);
  return sortedSamples[
    Math.min(sortedSamples.length - 1, Math.max(0, rank - 1))
  ] as number;
}

export function distribution(samples: readonly number[]): Distribution {
  if (samples.length === 0) {
    throw new Error("Cannot summarize an empty latency sample");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    min: rounded(sorted[0] as number),
    p50: rounded(percentile(sorted, 50)),
    p90: rounded(percentile(sorted, 90)),
    p95: rounded(percentile(sorted, 95)),
    p99: rounded(percentile(sorted, 99)),
    max: rounded(sorted.at(-1) as number),
    mean: rounded(
      sorted.reduce((sum, sample) => sum + sample, 0) / sorted.length,
    ),
  };
}

export function verifyProofResponse(response: string, proof: string): void {
  const normalized = response.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (!normalized.includes(proof.toUpperCase())) {
    throw new Error(
      `Live model response did not contain the requested proof ${proof}: ${JSON.stringify(response)}`,
    );
  }
}

export function verifyExactResponseParity(
  streamedResponse: string,
  finalResponse: string,
): void {
  if (streamedResponse !== finalResponse) {
    throw new Error(
      `Streamed response did not exactly match the final response: ${JSON.stringify(
        { streamedResponse, finalResponse },
      )}`,
    );
  }
}

function positiveIntegerSetting(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function stageHistograms(
  flows: ReturnType<typeof buildInferenceTimingDevPayload>["flows"],
): Partial<Record<InferenceFlowStage, Distribution>> {
  const samples = new Map<InferenceFlowStage, number[]>();
  for (const flow of flows) {
    for (const stage of flow.stages) {
      const values = samples.get(stage.stage) ?? [];
      values.push(stage.totalMs);
      samples.set(stage.stage, values);
    }
  }
  return Object.fromEntries(
    [...samples.entries()].map(([stage, values]) => [
      stage,
      distribution(values),
    ]),
  );
}

function configuredModelEnvironment(model: string): void {
  process.env.ELIZA_PROVIDER = "cerebras";
  process.env.CEREBRAS_BASE_URL =
    process.env.CEREBRAS_BASE_URL?.trim() || "https://api.cerebras.ai/v1";
  process.env.CEREBRAS_MODEL = model;
  process.env.CEREBRAS_SMALL_MODEL = model;
  process.env.CEREBRAS_LARGE_MODEL = model;
  process.env.ELIZA_INFERENCE_TIMING = "0";
}

async function main(): Promise<void> {
  const apiKey = process.env.CEREBRAS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("CEREBRAS_API_KEY is required for live latency evidence");
  }
  const model = process.env.ELIZA_CEREBRAS_CHAT_MODEL?.trim() || DEFAULT_MODEL;
  const sampleCount = positiveIntegerSetting(
    "ELIZA_CEREBRAS_CHAT_SAMPLES",
    DEFAULT_SAMPLES,
  );
  const warmupCount = positiveIntegerSetting(
    "ELIZA_CEREBRAS_CHAT_WARMUPS",
    DEFAULT_WARMUPS,
  );
  configuredModelEnvironment(model);

  const { default: openaiPlugin } = await import(
    "../../../plugins/plugin-openai/index.ts"
  );
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "CerebrasLatencyAudit",
    plugins: [openaiPlugin],
  });
  try {
    const modelUsageEvents: ModelEventPayload[] = [];
    runtime.registerEvent(EventType.MODEL_USED, async (payload) => {
      modelUsageEvents.push(payload);
    });
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    await runtime.ensureWorldExists({
      id: worldId,
      name: "Cerebras latency audit",
      agentId: runtime.agentId,
    });
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId,
      worldName: "Cerebras latency audit",
      userName: "Latency auditor",
      name: "Latency auditor",
      source: "cerebras_latency_audit",
      channelId: roomId,
      type: ChannelType.DM,
    });
    await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

    const runTurn = async (index: number, warmup: boolean) => {
      const proof = `SPEED-${warmup ? "W" : "S"}-${index}`;
      const prompt = `Reply with exactly ${proof} and no other text.`;
      const message = createMessageMemory({
        id: randomUUID() as UUID,
        entityId,
        roomId,
        content: {
          text: prompt,
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });
      const streamed: string[] = [];
      const usageEventOffset = modelUsageEvents.length;
      const startedAt = performance.now();
      const result = await generateChatResponse(
        runtime,
        message as Memory,
        runtime.character.name,
        {
          onChunk: (chunk) => {
            streamed.push(chunk);
          },
        },
      );
      const wallMs = performance.now() - startedAt;
      const turnUsageEvents = modelUsageEvents.slice(usageEventOffset);
      const modelUsagePayload = turnUsageEvents[0];
      if (turnUsageEvents.length !== 1 || !modelUsagePayload) {
        throw new Error(
          `Expected one MODEL_USED event for ${proof}, observed ${turnUsageEvents.length}`,
        );
      }
      const modelUsage = modelUsageEvidence(modelUsagePayload, model);
      const streamedText = streamed.join("");
      try {
        verifyProofResponse(result.text, proof);
        verifyProofResponse(streamedText, proof);
        verifyExactResponseParity(streamedText, result.text);
      } catch (cause) {
        throw new Error(
          `Live chat proof validation failed: ${JSON.stringify({
            proof,
            result,
            streamedText,
            wallMs: rounded(wallMs),
          })}`,
          { cause },
        );
      }
      const quiescenceStartedAt = performance.now();
      const backgroundTasks = await drainPostDeliveryTasks(runtime);
      const backgroundQuiescenceMs = performance.now() - quiescenceStartedAt;
      const totalToQuiescenceMs = performance.now() - startedAt;
      const recentMessages = await runtime.getMemories({
        roomId,
        tableName: "messages",
        limit: 12,
      });
      const persistedResponse = recentMessages.find((memory) => {
        const text = (memory.content as { text?: unknown }).text;
        return (
          memory.entityId === runtime.agentId &&
          typeof text === "string" &&
          text === result.text
        );
      });
      if (!persistedResponse?.id) {
        throw new Error(
          `Live assistant response was not persisted: ${JSON.stringify({
            proof,
            output: result.text,
            returnedPersistenceIds: result.persistedResponseMessageIds ?? [],
          })}`,
        );
      }
      if (
        result.persistedResponseMessageIds?.length &&
        !result.persistedResponseMessageIds.includes(persistedResponse.id)
      ) {
        throw new Error(
          `Returned persistence ids do not contain the exact assistant memory: ${JSON.stringify(
            {
              proof,
              persistedResponseId: persistedResponse.id,
              returnedPersistenceIds: result.persistedResponseMessageIds,
            },
          )}`,
        );
      }
      return {
        index,
        proof,
        prompt,
        output: result.text,
        wallMs: rounded(wallMs),
        backgroundTasks,
        backgroundQuiescenceMs: rounded(backgroundQuiescenceMs),
        totalToQuiescenceMs: rounded(totalToQuiescenceMs),
        streamedOutput: streamedText,
        streamedCharacters: streamedText.length,
        outputCharacters: result.text.length,
        usage: result.usage,
        modelUsage,
        failureKind: result.failureKind ?? null,
        persistedResponse: {
          id: persistedResponse.id,
          entityId: persistedResponse.entityId,
          roomId: persistedResponse.roomId,
          text: (persistedResponse.content as { text: string }).text,
          returnedByMessageService:
            result.persistedResponseMessageIds?.includes(
              persistedResponse.id,
            ) ?? false,
        },
      };
    };

    for (let index = 0; index < warmupCount; index += 1) {
      await runTurn(index, true);
    }
    inferenceTimingRegistry.reset();

    const turns = [];
    for (let index = 0; index < sampleCount; index += 1) {
      turns.push(await runTurn(index, false));
    }
    const chatTelemetry = buildInferenceTimingDevPayload(sampleCount);
    if (chatTelemetry.turns.length !== sampleCount) {
      throw new Error(
        `Expected ${sampleCount} timed turns, observed ${chatTelemetry.turns.length}`,
      );
    }
    if (turns.some((turn) => turn.usage.llmCalls !== 1)) {
      throw new Error(
        "Every benchmark turn must make exactly one live LLM call",
      );
    }

    const registeredProviderNames = runtime.providers.map(
      (provider) => provider.name,
    );
    inferenceTimingRegistry.reset();
    const providerSweepWallMs: number[] = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const message = createMessageMemory({
        id: randomUUID() as UUID,
        entityId,
        roomId,
        content: {
          text: `Provider telemetry sweep ${index}`,
          source: "provider_latency_audit",
          channelType: ChannelType.DM,
        },
      });
      const timer = new InferenceTurnTimer({
        turnId: `provider-sweep-${index}`,
        label: "all-provider-sweep",
        roomId,
      });
      const startedAt = performance.now();
      await runWithInferenceTiming(timer, () =>
        runtime.composeState(
          message as Memory,
          registeredProviderNames,
          true,
          true,
        ),
      );
      providerSweepWallMs.push(performance.now() - startedAt);
      inferenceTimingRegistry.record(timer.close());
      await drainPostDeliveryTasks(runtime);
    }
    const providerSweepTelemetry = buildInferenceTimingDevPayload(sampleCount);

    const report = {
      generatedAt: new Date().toISOString(),
      runtime: "AgentRuntime + plugin-sql/PGLite + plugin-openai",
      endpoint: process.env.CEREBRAS_BASE_URL,
      model,
      reasoningEffort: "omitted (Gemma 4 has no reasoning-effort control)",
      embeddingMode:
        "plugin-openai deterministic local token/bigram feature hashing (Cerebras exposes no embedding endpoint)",
      execution:
        "production generateChatResponse path with streaming, persistence, and distinct proof validation",
      warmups: warmupCount,
      samples: sampleCount,
      registeredProviders: registeredProviderNames,
      wallMs: distribution(turns.map((turn) => turn.wallMs)),
      backgroundQuiescenceMs: distribution(
        turns.map((turn) => turn.backgroundQuiescenceMs),
      ),
      totalToQuiescenceMs: distribution(
        turns.map((turn) => turn.totalToQuiescenceMs),
      ),
      stageHistograms: stageHistograms(chatTelemetry.flows),
      derivedHistograms: chatTelemetry.derivedHistograms satisfies Record<
        string,
        InferenceHistogramSummary
      >,
      spanHistograms: chatTelemetry.spanHistograms,
      providerTelemetry: chatTelemetry.providers,
      allProviderSweep: {
        execution:
          "every registered provider explicitly selected and executed concurrently by AgentRuntime.composeState",
        samples: sampleCount,
        wallMs: distribution(providerSweepWallMs),
        providerTelemetry: providerSweepTelemetry.providers,
        turns: providerSweepTelemetry.turns,
      },
      turns,
      inferenceTurns: chatTelemetry.turns,
      flows: chatTelemetry.flows,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const reportPath = process.env.ELIZA_CEREBRAS_CHAT_REPORT?.trim();
    if (reportPath) await writeFile(reportPath, json, "utf8");
    process.stdout.write(json);
  } finally {
    await cleanup();
  }
}

// error-policy:J1 CLI boundary translates failure into a non-zero process.
if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Cerebras chat-flow latency audit failed: ${
        error instanceof Error ? error.stack : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
