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
  type InferenceTurnSummary,
  InferenceTurnTimer,
  inferenceTimingRegistry,
  type Memory,
  runWithInferenceTiming,
  runWithTrajectoryContext,
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

type ProviderTelemetry = ReturnType<
  typeof buildInferenceTimingDevPayload
>["providers"][number];

export function verifyProviderSweepTelemetry(
  providerNames: readonly string[],
  fresh: readonly ProviderTelemetry[],
  reused: readonly ProviderTelemetry[],
  samples: number,
): void {
  const freshByName = new Map(
    fresh.map((provider) => [provider.providerName, provider]),
  );
  const reusedByName = new Map(
    reused.map((provider) => [provider.providerName, provider]),
  );
  const failures: string[] = [];

  for (const providerName of providerNames) {
    const freshProvider = freshByName.get(providerName);
    if (!freshProvider) {
      failures.push(`${providerName}: missing fresh telemetry`);
    } else if (
      freshProvider.execution.count !== samples ||
      freshProvider.successes !== samples ||
      freshProvider.cacheHits !== 0 ||
      freshProvider.errors !== 0 ||
      freshProvider.aborted !== 0 ||
      freshProvider.deadlineExceeded !== 0 ||
      freshProvider.unknown !== 0
    ) {
      failures.push(
        `${providerName}: invalid fresh telemetry ${JSON.stringify(freshProvider)}`,
      );
    }

    const reusedProvider = reusedByName.get(providerName);
    if (!reusedProvider) {
      failures.push(`${providerName}: missing maximum-reuse telemetry`);
    } else if (
      reusedProvider.cacheHits !== samples ||
      reusedProvider.execution.count !== 0 ||
      reusedProvider.successes !== 0 ||
      reusedProvider.errors !== 0 ||
      reusedProvider.aborted !== 0 ||
      reusedProvider.deadlineExceeded !== 0 ||
      reusedProvider.unknown !== 0
    ) {
      failures.push(
        `${providerName}: invalid maximum-reuse telemetry ${JSON.stringify(reusedProvider)}`,
      );
    }
  }

  if (
    freshByName.size !== providerNames.length ||
    reusedByName.size !== providerNames.length
  ) {
    failures.push(
      `provider cardinality mismatch: registered=${providerNames.length}, fresh=${freshByName.size}, maximumReuse=${reusedByName.size}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Provider sweep verification failed:\n${failures.join("\n")}`,
    );
  }
}

export function providerParallelismRatio(
  summary: InferenceTurnSummary,
): number {
  if (summary.totalMs === null || summary.totalMs <= 0) {
    throw new Error(`Provider sweep turn ${summary.turnId} has no wall time`);
  }
  const providerWorkMs = summary.spans
    .filter(
      (span) =>
        span.name.startsWith("provider:") && span.meta?.outcome === "success",
    )
    .reduce((total, span) => total + span.durationMs, 0);
  return rounded(providerWorkMs / summary.totalMs);
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
    const agentName = runtime.character.name;
    if (!agentName) {
      throw new Error("Latency runtime character must have a name");
    }
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
        agentName,
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
    const chatTelemetry = buildInferenceTimingDevPayload(sampleCount);
    if (chatTelemetry.turns.length !== sampleCount) {
      throw new Error(
        `Expected ${sampleCount} timed turns, observed ${chatTelemetry.turns.length}`,
      );
    }
    if (turns.some((turn) => turn.usage?.llmCalls !== 1)) {
      throw new Error(
        "Every benchmark turn must make exactly one live LLM call",
      );
    }

    const registeredProviderNames = runtime.providers.map(
      (provider) => provider.name,
    );
    inferenceTimingRegistry.reset();
    const providerSweepFreshWallMs: number[] = [];
    const providerSweepReusedWallMs: number[] = [];
    const providerSweepFreshSummaries: InferenceTurnSummary[] = [];
    const providerSweepReusedSummaries: InferenceTurnSummary[] = [];
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
        turnId: `provider-sweep-fresh-${index}`,
        label: "all-provider-sweep-fresh",
        roomId,
      });
      const reusedTimer = new InferenceTurnTimer({
        turnId: `provider-sweep-reused-${index}`,
        label: "all-provider-sweep-reused",
        roomId,
      });
      await runWithTrajectoryContext(
        { turnMemo: new Map<string, Promise<unknown>>() },
        async () => {
          const freshStartedAt = performance.now();
          await runWithInferenceTiming(timer, () =>
            runtime.composeState(
              message as Memory,
              registeredProviderNames,
              true,
            ),
          );
          providerSweepFreshWallMs.push(performance.now() - freshStartedAt);

          const reusedStartedAt = performance.now();
          await runWithInferenceTiming(reusedTimer, () =>
            runtime.composeState(
              message as Memory,
              registeredProviderNames,
              true,
              false,
              [],
            ),
          );
          providerSweepReusedWallMs.push(performance.now() - reusedStartedAt);
        },
      );
      providerSweepFreshSummaries.push(timer.close());
      providerSweepReusedSummaries.push(reusedTimer.close());
      await drainPostDeliveryTasks(runtime);
    }
    for (const summary of providerSweepFreshSummaries) {
      inferenceTimingRegistry.record(summary);
    }
    const providerSweepFreshTelemetry =
      buildInferenceTimingDevPayload(sampleCount);
    inferenceTimingRegistry.reset();
    for (const summary of providerSweepReusedSummaries) {
      inferenceTimingRegistry.record(summary);
    }
    const providerSweepReusedTelemetry =
      buildInferenceTimingDevPayload(sampleCount);
    verifyProviderSweepTelemetry(
      registeredProviderNames,
      providerSweepFreshTelemetry.providers,
      providerSweepReusedTelemetry.providers,
      sampleCount,
    );

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
          "every registered provider explicitly selected; fresh providers execute concurrently, then the identical message composes again with maximum same-turn reuse",
        samples: sampleCount,
        fresh: {
          wallMs: distribution(providerSweepFreshWallMs),
          parallelismRatio: distribution(
            providerSweepFreshSummaries.map(providerParallelismRatio),
          ),
          providerTelemetry: providerSweepFreshTelemetry.providers,
          turns: providerSweepFreshTelemetry.turns,
        },
        maximumReuse: {
          wallMs: distribution(providerSweepReusedWallMs),
          providerTelemetry: providerSweepReusedTelemetry.providers,
          turns: providerSweepReusedTelemetry.turns,
        },
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
