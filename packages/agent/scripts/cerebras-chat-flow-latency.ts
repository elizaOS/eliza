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
  type InferenceFlowStage,
  type InferenceHistogramSummary,
  inferenceTimingRegistry,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import openaiPlugin from "../../../plugins/plugin-openai/index.ts";
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

  const { runtime, cleanup } = await createTestRuntime({
    characterName: "CerebrasLatencyAudit",
    plugins: [openaiPlugin],
  });
  try {
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
      verifyProofResponse(result.text, proof);
      verifyProofResponse(streamed.join(""), proof);
      const quiescenceStartedAt = performance.now();
      const backgroundTasks = await drainPostDeliveryTasks(runtime);
      const backgroundQuiescenceMs = performance.now() - quiescenceStartedAt;
      return {
        index,
        proof,
        prompt,
        output: result.text,
        wallMs: rounded(wallMs),
        backgroundTasks,
        backgroundQuiescenceMs: rounded(backgroundQuiescenceMs),
        totalToQuiescenceMs: rounded(performance.now() - startedAt),
        streamedCharacters: streamed.join("").length,
        outputCharacters: result.text.length,
        usage: result.usage,
        failureKind: result.failureKind ?? null,
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
    const telemetry = buildInferenceTimingDevPayload(sampleCount);
    if (telemetry.turns.length !== sampleCount) {
      throw new Error(
        `Expected ${sampleCount} timed turns, observed ${telemetry.turns.length}`,
      );
    }
    if (turns.some((turn) => turn.usage.llmCalls !== 1)) {
      throw new Error(
        "Every benchmark turn must make exactly one live LLM call",
      );
    }

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
      registeredProviders: runtime.providers.map((provider) => provider.name),
      wallMs: distribution(turns.map((turn) => turn.wallMs)),
      backgroundQuiescenceMs: distribution(
        turns.map((turn) => turn.backgroundQuiescenceMs),
      ),
      totalToQuiescenceMs: distribution(
        turns.map((turn) => turn.totalToQuiescenceMs),
      ),
      stageHistograms: stageHistograms(telemetry.flows),
      derivedHistograms: telemetry.derivedHistograms satisfies Record<
        string,
        InferenceHistogramSummary
      >,
      spanHistograms: telemetry.spanHistograms,
      providerTelemetry: telemetry.providers,
      turns,
      inferenceTurns: telemetry.turns,
      flows: telemetry.flows,
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
