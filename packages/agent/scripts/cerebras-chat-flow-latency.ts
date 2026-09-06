#!/usr/bin/env bun
/**
 * Measures the complete production chat path against a configured Cerebras model.
 *
 * A real PGLite-backed AgentRuntime processes every turn through providers,
 * model routing, streaming, persistence, delivery, and lifecycle events. The
 * report retains synthetic prompts and outputs so reviewers can verify that
 * each live response was distinct rather than served by a fabricated fallback.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentRuntime,
  buildInferenceTimingDevPayload,
  ChannelType,
  createMessageMemory,
  drainPostDeliveryTasks,
  EventType,
  type InferenceFlowStage,
  type InferenceHistogramSummary,
  InferenceTurnTimer,
  inferenceTimingRegistry,
  isSensitiveKeyName,
  isTextGenerationModelType,
  type Memory,
  type ModelEventPayload,
  ModelType,
  redactSensitiveText,
  runWithInferenceTiming,
  type UUID,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/core/testing";
import { generateChatResponse } from "../src/api/chat-routes.ts";
import {
  applyCacheExperiment,
  type CacheExperimentMode,
  measuredProviderFetch,
  type ProviderWireEvidence,
  requireRealEmbeddingConfig,
  runChatCondition,
} from "./cerebras-chat-flow-experiment.ts";

const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 3;
const IMPORTABLE_SOURCE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

// These roots are the workspace inputs in the live command's Bun
// `eliza-source` graph. plugin-sql is added explicitly because its package name
// is assembled dynamically by the real PGLite test-runtime factory.
const CEREBRAS_LIVE_SOURCE_PATHS = [
  "packages/agent/scripts/cerebras-chat-flow-latency.ts",
  "packages/agent/scripts/cerebras-chat-flow-experiment.ts",
  "packages/agent/src",
  "packages/cloud/routing/src",
  "packages/core/src",
  "packages/logger/src",
  "packages/prompts/src",
  "packages/registry/src",
  "packages/shared/src",
  "packages/vault/src",
  "plugins/plugin-aosp-local-inference/src",
  "plugins/plugin-capacitor-bridge/src",
  "plugins/plugin-local-inference/src",
  "plugins/plugin-openai",
  "plugins/plugin-sql/src",
] as const;
const IGNORED_SOURCE_ARTIFACT_SEGMENTS = new Set([
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const GENERATED_SOURCE_OUTPUT_PATHS = [
  "packages/core/src/i18n/generated",
  "packages/shared/src/i18n/generated",
] as const;

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

export interface PromptCacheTelemetry {
  promptTokens: Distribution;
  cachedPromptTokens: Distribution;
  uncachedPromptTokens: Distribution;
  cacheRatePercent: Distribution;
}

export interface ModelInputContext {
  phase: "warmup" | "sample" | "cancellation" | "isolation";
  index?: number;
  proof: string;
  roomId?: string;
}

export interface ModelInputEvidence {
  context: ModelInputContext | null;
  modelType: string;
  prompt?: string;
  messages?: unknown;
  promptSegments?: unknown;
  tools?: unknown;
  responseSchema?: unknown;
  providerOptions?: unknown;
  maxTokens?: number;
  stream?: boolean;
}

function isTokenMetricKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.endsWith("tokens") ||
    normalized.endsWith("tokencount") ||
    normalized === "maxtokens"
  );
}

function redactEvidenceValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const redacted = value.map((entry) => redactEvidenceValue(entry, seen));
    seen.delete(value);
    return redacted;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] =
      isSensitiveKeyName(key) && !isTokenMetricKey(key)
        ? "[REDACTED]"
        : redactEvidenceValue(entry, seen);
  }
  seen.delete(value);
  return redacted;
}

function jsonEvidence(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(redactEvidenceValue(value, new WeakSet<object>())),
  );
}

function nulDelimitedPaths(output: string): string[] {
  const paths = output.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

function isAttestedIgnoredSource(path: string): boolean {
  if (/\.d\.[cm]?ts$/u.test(path)) return false;
  if (!IMPORTABLE_SOURCE_EXTENSIONS.includes(extname(path))) {
    return false;
  }
  if (
    path
      .split("/")
      .some((segment) => IGNORED_SOURCE_ARTIFACT_SEGMENTS.has(segment))
  ) {
    return false;
  }
  return !GENERATED_SOURCE_OUTPUT_PATHS.some(
    (generatedPath) =>
      path === generatedPath || path.startsWith(`${generatedPath}/`),
  );
}

export function sourceRevisionEvidence(
  repoRoot = fileURLToPath(new URL("../../..", import.meta.url)),
  attestedSourcePaths: readonly string[] = CEREBRAS_LIVE_SOURCE_PATHS,
): { head: string; treeClean: true } {
  const head = execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync(
    "git",
    [
      "-C",
      repoRoot,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { encoding: "utf8" },
  );
  const ignoredSourceOverrides = nulDelimitedPaths(
    execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ...attestedSourcePaths,
      ],
      { encoding: "utf8" },
    ),
  ).filter(isAttestedIgnoredSource);
  if (dirty.length > 0 || ignoredSourceOverrides.length > 0) {
    throw new Error(
      "Live Cerebras evidence must run from a clean committed source tree",
    );
  }
  return { head, treeClean: true };
}

export function captureModelInput(
  modelType: unknown,
  params: unknown,
  context: ModelInputContext | null,
): ModelInputEvidence {
  const input =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)
      : {};
  return {
    context: context ? { ...context } : null,
    modelType: String(modelType),
    ...(typeof input.prompt === "string"
      ? { prompt: redactSensitiveText(input.prompt) }
      : {}),
    ...(input.messages !== undefined
      ? { messages: jsonEvidence(input.messages) }
      : {}),
    ...(input.promptSegments !== undefined
      ? { promptSegments: jsonEvidence(input.promptSegments) }
      : {}),
    ...(input.tools !== undefined ? { tools: jsonEvidence(input.tools) } : {}),
    ...(input.responseSchema !== undefined
      ? { responseSchema: jsonEvidence(input.responseSchema) }
      : {}),
    ...(input.providerOptions !== undefined
      ? { providerOptions: jsonEvidence(input.providerOptions) }
      : {}),
    ...(typeof input.maxTokens === "number"
      ? { maxTokens: input.maxTokens }
      : {}),
    ...(typeof input.stream === "boolean" ? { stream: input.stream } : {}),
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

export function promptCacheTelemetry(
  turns: readonly {
    modelUsage: {
      tokens: {
        prompt: number;
        cachedInputTokens?: number;
        cacheReadInputTokens?: number;
      };
    };
  }[],
): PromptCacheTelemetry {
  const promptTokens: number[] = [];
  const cachedPromptTokens: number[] = [];
  const uncachedPromptTokens: number[] = [];
  const cacheRatePercent: number[] = [];
  for (const turn of turns) {
    const prompt = turn.modelUsage.tokens.prompt;
    const cached =
      turn.modelUsage.tokens.cachedInputTokens ??
      turn.modelUsage.tokens.cacheReadInputTokens;
    if (!Number.isFinite(prompt) || prompt <= 0) {
      throw new Error(
        "Cerebras cache telemetry requires positive prompt tokens",
      );
    }
    if (cached === undefined || !Number.isFinite(cached) || cached < 0) {
      throw new Error(
        "Cerebras cache telemetry requires provider-reported cached prompt tokens",
      );
    }
    if (cached > prompt) {
      throw new Error(
        `Cerebras reported more cached tokens than prompt tokens: ${cached} > ${prompt}`,
      );
    }
    promptTokens.push(prompt);
    cachedPromptTokens.push(cached);
    uncachedPromptTokens.push(prompt - cached);
    cacheRatePercent.push((cached / prompt) * 100);
  }
  return {
    promptTokens: distribution(promptTokens),
    cachedPromptTokens: distribution(cachedPromptTokens),
    uncachedPromptTokens: distribution(uncachedPromptTokens),
    cacheRatePercent: distribution(cacheRatePercent),
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
  const model = process.env.ELIZA_CEREBRAS_CHAT_MODEL?.trim();
  if (!model)
    throw new Error(
      "Set ELIZA_CEREBRAS_CHAT_MODEL to an independently verified available model",
    );
  const sampleCount = positiveIntegerSetting(
    "ELIZA_CEREBRAS_CHAT_SAMPLES",
    DEFAULT_SAMPLES,
  );
  const warmupCount = positiveIntegerSetting(
    "ELIZA_CEREBRAS_CHAT_WARMUPS",
    DEFAULT_WARMUPS,
  );
  const sourceRevision = sourceRevisionEvidence();
  const nativeEmbedding =
    process.env.ELIZA_CEREBRAS_EMBEDDING_MODE === "native";
  const embedding = nativeEmbedding
    ? {
        endpoint: "native://fused",
        model: process.env.LOCAL_EMBEDDING_MODEL?.trim() || "",
        dimensions: positiveIntegerSetting("LOCAL_EMBEDDING_DIMENSIONS", 384),
      }
    : requireRealEmbeddingConfig(process.env);
  let nativeProvenance: {
    modelPath: string;
    modelSha256: string;
    libraryPath: string;
    librarySha256: string;
  } | null = null;
  let bootNative: ((runtime: AgentRuntime) => Promise<void>) | undefined;
  if (nativeEmbedding) {
    const modelsDir = process.env.MODELS_DIR?.trim();
    if (!modelsDir || !embedding.model)
      throw new Error(
        "Native embeddings require explicit MODELS_DIR and LOCAL_EMBEDDING_MODEL",
      );
    const { resolveFusedEmbeddingBundleRoot } = await import(
      "../../../plugins/plugin-local-inference/src/runtime/fused-embedding-bundle.ts"
    );
    const { resolveFusedLibraryPath } = await import(
      "../../../plugins/plugin-local-inference/src/services/desktop-fused-ffi-backend-runtime.ts"
    );
    const { ensureLocalInferenceHandler } = await import(
      "@elizaos/plugin-local-inference/runtime"
    );
    const bundle = resolveFusedEmbeddingBundleRoot({
      modelsDir,
      model: embedding.model,
    });
    const libraryPath = bundle ? resolveFusedLibraryPath(bundle) : null;
    if (!libraryPath)
      throw new Error("Installed fused embedding library/model unavailable");
    const modelPath = join(modelsDir, embedding.model);
    nativeProvenance = {
      modelPath,
      libraryPath,
      modelSha256: createHash("sha256")
        .update(await readFile(modelPath))
        .digest("hex"),
      librarySha256: createHash("sha256")
        .update(await readFile(libraryPath))
        .digest("hex"),
    };
    bootNative = ensureLocalInferenceHandler;
  }
  const cacheMode = process.env.ELIZA_CEREBRAS_CACHE_MODE?.trim();
  if (
    cacheMode !== "existing" &&
    cacheMode !== "automatic" &&
    cacheMode !== "conversation"
  ) {
    throw new Error(
      "ELIZA_CEREBRAS_CACHE_MODE must explicitly select existing, automatic or conversation",
    );
  }
  const pathKind = process.env.ELIZA_CEREBRAS_CHAT_PATH?.trim();
  if (pathKind !== "direct" && pathKind !== "gateway") {
    throw new Error(
      "ELIZA_CEREBRAS_CHAT_PATH must identify direct or gateway execution",
    );
  }
  const gatewaySourceRevision =
    process.env.ELIZA_CEREBRAS_GATEWAY_SOURCE_REVISION?.trim();
  if (
    pathKind === "gateway" &&
    !/^[a-f0-9]{40}$/.test(gatewaySourceRevision ?? "")
  ) {
    throw new Error(
      "Gateway evidence requires an attested ELIZA_CEREBRAS_GATEWAY_SOURCE_REVISION",
    );
  }
  const condition = process.env.ELIZA_CEREBRAS_CHAT_CONDITION?.trim();
  if (
    condition !== "rolling-history" &&
    condition !== "fresh-room" &&
    condition !== "post-idle"
  ) {
    throw new Error(
      "ELIZA_CEREBRAS_CHAT_CONDITION must select rolling-history, fresh-room or post-idle",
    );
  }
  const idleMs =
    condition === "post-idle"
      ? positiveIntegerSetting("ELIZA_CEREBRAS_CHAT_IDLE_MS", 360_000)
      : 0;
  const keyCapabilityConfirmed =
    process.env.ELIZA_CEREBRAS_CACHE_KEY_CAPABILITY_CONFIRMED === "true";
  if (cacheMode !== "automatic" && !keyCapabilityConfirmed) {
    throw new Error(
      "Confirm account prompt_cache_key capability before a keyed live run",
    );
  }
  configuredModelEnvironment(model);
  const endpoint = new URL(process.env.CEREBRAS_BASE_URL as string);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      "Text endpoint must be HTTP(S) without embedded credentials, query or fragment",
    );
  }

  // OpenAI's null-input initialization probe sizes the SQL vector column;
  // real native calls below explicitly select the canonical native provider.
  if (nativeEmbedding)
    process.env.OPENAI_EMBEDDING_DIMENSIONS = String(embedding.dimensions);
  const { default: openaiPlugin } = await import(
    "../../../plugins/plugin-openai/index.ts"
  );
  process.stderr.write("[cerebras-benchmark] initializing runtime\n");
  const { runtime, cleanup } = await createTestRuntime({
    characterName: "CerebrasLatencyAudit",
    plugins: [openaiPlugin],
    embeddingDimensions: embedding.dimensions,
  });
  const originalFetch = globalThis.fetch;
  const wireEvidence: ProviderWireEvidence[] = [];
  const modelContext = new AsyncLocalStorage<ModelInputContext>();
  globalThis.fetch = measuredProviderFetch(
    originalFetch,
    {
      text: process.env.CEREBRAS_BASE_URL as string,
      embedding: embedding.endpoint,
    },
    () => modelContext.getStore() ?? null,
    (evidence) => wireEvidence.push(evidence),
  );
  try {
    if (bootNative) {
      process.stderr.write(
        "[cerebras-benchmark] booting canonical native embeddings\n",
      );
      await bootNative(runtime);
    }
    process.stderr.write("[cerebras-benchmark] runtime ready\n");
    const modelUsageEvents: Array<{
      payload: ModelEventPayload;
      context: ModelInputContext | null;
    }> = [];
    runtime.registerEvent(EventType.MODEL_USED, async (payload) => {
      modelUsageEvents.push({
        payload,
        context: modelContext.getStore() ?? null,
      });
    });
    const modelInputs: ModelInputEvidence[] = [];
    const modelExecutions: Array<{
      modelType: string;
      context: ModelInputContext | null;
      durationMs: number;
      outcome: "success" | "error";
    }> = [];
    const measuredUseModel = runtime.useModel.bind(runtime);
    runtime.useModel = (async (modelType, params, provider) => {
      const activeModelInputContext = modelContext.getStore() ?? null;
      const isTextModel = isTextGenerationModelType(modelType);
      const context = activeModelInputContext
        ? { ...activeModelInputContext }
        : null;
      const startedAt = performance.now();
      let outcome: "success" | "error" = "error";
      try {
        const measuredParams = isTextModel
          ? applyCacheExperiment(params, {
              mode: cacheMode as CacheExperimentMode,
              keyCapabilityConfirmed,
              agentId: runtime.agentId,
              conversationId: activeModelInputContext?.roomId ?? roomId,
              model,
              stage: String(modelType),
            })
          : params;
        if (isTextModel) {
          modelInputs.push(
            captureModelInput(
              modelType,
              measuredParams,
              activeModelInputContext,
            ),
          );
        }
        const result = await measuredUseModel(
          modelType,
          measuredParams,
          nativeEmbedding && modelType === ModelType.TEXT_EMBEDDING
            ? "eliza-local-inference"
            : provider,
        );
        if (nativeEmbedding && modelType === ModelType.TEXT_EMBEDDING) {
          if (
            !Array.isArray(result) ||
            result.length !== embedding.dimensions ||
            !result.every(
              (value) => typeof value === "number" && Number.isFinite(value),
            ) ||
            !result.some((value) => value !== 0)
          ) {
            throw new Error("Native embedding returned an invalid vector");
          }
          if (wireEvidence.some((wire) => wire.kind === "embedding"))
            throw new Error("Native embedding unexpectedly fell back to HTTP");
        }
        outcome = "success";
        return result;
      } finally {
        modelExecutions.push({
          modelType: String(modelType),
          context,
          durationMs: performance.now() - startedAt,
          outcome,
        });
      }
    }) as typeof runtime.useModel;
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

    const lastRoomCompletion = new Map<string, number>();
    const prepareRoom = async () => {
      const id = randomUUID() as UUID;
      await runtime.ensureConnection({
        entityId,
        roomId: id,
        worldId,
        worldName: "Cerebras latency audit",
        userName: "Latency auditor",
        name: "Latency auditor",
        source: "cerebras_latency_audit",
        channelId: id,
        type: ChannelType.DM,
      });
      await runtime.ensureParticipantInRoom(runtime.agentId, id);
      return id;
    };
    const runTurn = async (
      index: number,
      warmup: boolean,
      turnRoomId: string = roomId,
      fixture?: { proof: string; prompt: string },
    ) => {
      const proof = fixture?.proof ?? `SPEED-${warmup ? "W" : "S"}-${index}`;
      const prompt =
        fixture?.prompt ??
        `I am labelling a parcel. Its reference is ${proof}. What exact reference should I write on the label?`;
      const message = createMessageMemory({
        id: randomUUID() as UUID,
        entityId,
        roomId: turnRoomId as UUID,
        content: {
          text: prompt,
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });
      const streamed: string[] = [];
      const usageEventOffset = modelUsageEvents.length;
      const startedAt = performance.now();
      const previousCompletedAt = lastRoomCompletion.get(turnRoomId);
      const observedIdleMs =
        previousCompletedAt === undefined
          ? null
          : startedAt - previousCompletedAt;
      let firstTextAt: number | null = null;
      const context: ModelInputContext = {
        phase: fixture ? "isolation" : warmup ? "warmup" : "sample",
        index,
        proof,
        roomId: turnRoomId,
      };
      let result: Awaited<ReturnType<typeof generateChatResponse>>;
      result = await modelContext.run(context, () =>
        generateChatResponse(
          runtime,
          message as Memory,
          runtime.character.name ?? "CerebrasLatencyAudit",
          {
            onChunk: (chunk) => {
              if (chunk.length > 0 && firstTextAt === null)
                firstTextAt = performance.now();
              streamed.push(chunk);
            },
          },
        ),
      );
      const wallMs = performance.now() - startedAt;
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
      const failedModels = modelExecutions.filter(
        (execution) =>
          execution.context?.proof === proof && execution.outcome === "error",
      );
      if (failedModels.length > 0) {
        throw new Error(
          `Model execution failed during ${proof}, including post-delivery work: ${failedModels.map((execution) => execution.modelType).join(", ")}`,
        );
      }
      const turnUsageEvents = modelUsageEvents
        .slice(usageEventOffset)
        .filter(
          (event) =>
            event.context?.proof === proof &&
            event.payload.type !== ModelType.TEXT_EMBEDDING,
        )
        .map((event) => event.payload);
      if (turnUsageEvents.length === 0)
        throw new Error(`No live MODEL_USED event for ${proof}`);
      const modelUsages = turnUsageEvents.map((event) =>
        modelUsageEvidence(event, model),
      );
      const recentMessages = await runtime.getMemories({
        roomId: turnRoomId as UUID,
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
      lastRoomCompletion.set(turnRoomId, performance.now());
      return {
        index,
        roomId: turnRoomId,
        observedIdleMs,
        proof,
        prompt,
        output: result.text,
        wallMs: rounded(wallMs),
        firstVisibleTextMs:
          firstTextAt === null ? null : rounded(firstTextAt - startedAt),
        backgroundTasks,
        backgroundQuiescenceMs: rounded(backgroundQuiescenceMs),
        totalToQuiescenceMs: rounded(totalToQuiescenceMs),
        streamedOutput: streamedText,
        streamedCharacters: streamedText.length,
        outputCharacters: result.text.length,
        usage: result.usage,
        modelUsages,
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

    const samples = await runChatCondition({
      condition,
      samples: sampleCount,
      idleMs,
      initialRoom: roomId,
      prepareRoom,
      runTurn,
      wait: async (milliseconds) => {
        process.stderr.write(
          `Waiting ${milliseconds}ms before resuming ${sampleCount} separately primed rooms.\n`,
        );
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        inferenceTimingRegistry.reset();
      },
    });
    const turns = samples.map((sample) => sample.value);
    const chatTelemetry = buildInferenceTimingDevPayload(sampleCount);
    if (chatTelemetry.turns.length !== sampleCount) {
      throw new Error(
        `Expected ${sampleCount} timed turns, observed ${chatTelemetry.turns.length}`,
      );
    }
    if (turns.some((turn) => !turn.usage || turn.usage.llmCalls < 1)) {
      throw new Error(
        "Every benchmark turn must report actual live model usage",
      );
    }

    const isolationRooms = await Promise.all([prepareRoom(), prepareRoom()]);
    const isolationProofs = [
      `PARCEL-A-${randomUUID()}`,
      `PARCEL-B-${randomUUID()}`,
    ];
    const isolationPriming = await Promise.all(
      isolationRooms.map((room, index) => {
        const proof = isolationProofs[index];
        if (!proof) throw new Error("Missing room isolation fixture");
        return runTurn(index, true, room, {
          proof,
          prompt: `My parcel reference for this conversation is ${proof}. Confirm the reference so I know you have it.`,
        });
      }),
    );
    const isolationResumption = await Promise.all(
      isolationRooms.map((room, index) => {
        const proof = isolationProofs[index];
        if (!proof) throw new Error("Missing room isolation fixture");
        return runTurn(index, false, room, {
          proof,
          prompt:
            "What parcel reference did I give you earlier in this conversation?",
        });
      }),
    );
    for (const [index, turn] of isolationResumption.entries()) {
      const otherProof = isolationProofs[1 - index];
      if (otherProof && turn.output.includes(otherProof))
        throw new Error("Concurrent recall leaked the other room's reference");
    }

    const cancellationProof = `CANCEL-${randomUUID()}`;
    const cancellationMessage = createMessageMemory({
      id: randomUUID() as UUID,
      entityId,
      roomId,
      content: {
        text: `Write a detailed response that ends with ${cancellationProof}.`,
        source: "cerebras_cancellation_audit",
        channelType: ChannelType.DM,
      },
    });
    const cancellationController = new AbortController();
    const cancellationReason = new Error(
      "Cancellation probe owner disconnected",
    );
    cancellationReason.name = "AbortError";
    const originalUseModel = runtime.useModel.bind(runtime);
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    let liveModelInvocationObserved = false;
    let invokedModelType: string | null = null;
    let modelSignalWasAlreadyAborted = false;
    runtime.useModel = (async (modelType, params, provider) => {
      const pending = originalUseModel(modelType, params, provider);
      if (
        !liveModelInvocationObserved &&
        modelType === ModelType.RESPONSE_HANDLER
      ) {
        liveModelInvocationObserved = true;
        invokedModelType = modelType;
        modelSignalWasAlreadyAborted =
          typeof params === "object" &&
          params !== null &&
          "signal" in params &&
          params.signal instanceof AbortSignal &&
          params.signal.aborted;
        cancellationTimer = setTimeout(() => {
          cancellationController.abort(cancellationReason);
        }, 25);
      }
      return await pending;
    }) as typeof runtime.useModel;

    const cancellationStartedAt = performance.now();
    let cancellationError: unknown;
    const cancellationContext: ModelInputContext = {
      phase: "cancellation",
      proof: cancellationProof,
      roomId,
    };
    try {
      await modelContext.run(cancellationContext, () =>
        generateChatResponse(
          runtime,
          cancellationMessage as Memory,
          runtime.character.name ?? "CerebrasLatencyAudit",
          { abortSignal: cancellationController.signal },
        ),
      );
      throw new Error("Cancellation probe unexpectedly completed");
    } catch (error) {
      cancellationError = error;
    } finally {
      runtime.useModel = originalUseModel;
      if (cancellationTimer) clearTimeout(cancellationTimer);
    }
    const cancellationWallMs = performance.now() - cancellationStartedAt;
    if (!liveModelInvocationObserved) {
      throw new Error(
        "Cancellation probe aborted before a live RESPONSE_HANDLER invocation",
      );
    }
    if (!cancellationController.signal.aborted) {
      throw new Error("Cancellation probe did not abort its owner signal");
    }
    if (
      cancellationError !== cancellationReason &&
      (!(cancellationError instanceof Error) ||
        !cancellationError.message.includes(cancellationReason.message))
    ) {
      throw new Error(
        `Cancellation probe rejected with the wrong reason: ${String(cancellationError)}`,
      );
    }
    const cancellationQuiescenceStartedAt = performance.now();
    const cancellationBackgroundTasks = await drainPostDeliveryTasks(runtime);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancellationBackgroundQuiescenceMs =
      performance.now() - cancellationQuiescenceStartedAt;
    const memoriesAfterCancellation = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 100,
    });
    const lateCancellationReplies = memoriesAfterCancellation.filter(
      (memory) =>
        memory.entityId === runtime.agentId &&
        String((memory.content as { text?: unknown }).text ?? "").includes(
          cancellationProof,
        ),
    );
    if (lateCancellationReplies.length > 0) {
      throw new Error(
        `Cancelled live turn persisted a late assistant reply: ${JSON.stringify(
          lateCancellationReplies.map((memory) => memory.id),
        )}`,
      );
    }
    const cancellationProbe = {
      proof: cancellationProof,
      execution:
        "production generateChatResponse path; owner abort scheduled after the live RESPONSE_HANDLER invocation began",
      liveModelInvocationObserved,
      invokedModelType,
      modelSignalWasAlreadyAborted,
      ownerSignalAborted: cancellationController.signal.aborted,
      rejection: {
        name:
          cancellationError instanceof Error
            ? cancellationError.name
            : typeof cancellationError,
        message:
          cancellationError instanceof Error
            ? cancellationError.message
            : String(cancellationError),
      },
      wallMs: rounded(cancellationWallMs),
      backgroundTasks: cancellationBackgroundTasks,
      backgroundQuiescenceMs: rounded(cancellationBackgroundQuiescenceMs),
      lateAssistantPersistenceIds: lateCancellationReplies.map(
        (memory) => memory.id,
      ),
    };

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

    const successfulEmbeddingCalls = modelExecutions.filter(
      (call) =>
        call.modelType === ModelType.TEXT_EMBEDDING &&
        call.outcome === "success",
    );
    if (
      successfulEmbeddingCalls.length === 0 ||
      (!nativeEmbedding &&
        !wireEvidence.some(
          (wire) => wire.kind === "embedding" && wire.status === 200,
        ))
    ) {
      throw new Error(
        "No successful real embedding execution and matching wire request observed; this run cannot certify production embedding timing",
      );
    }
    for (const turn of turns) {
      if (
        !wireEvidence.some(
          (wire) => wire.kind === "text" && wire.context?.proof === turn.proof,
        )
      ) {
        throw new Error(`Missing actual SDK wire request for ${turn.proof}`);
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      sourceRevision,
      runtime: "AgentRuntime + plugin-sql/PGLite + plugin-openai",
      endpoint: process.env.CEREBRAS_BASE_URL,
      model,
      reasoningEffort:
        process.env.OPENAI_REASONING_EFFORT?.trim() || "provider-default",
      embedding: { ...embedding, nativeProvenance },
      cacheExperiment: { mode: cacheMode, keyCapabilityConfirmed },
      workload: {
        condition,
        requestedIdleMs: idleMs,
        cacheTemperature:
          "Only provider-reported cached token counts establish reuse; fresh-room is not asserted cold",
      },
      errorRatePercent: 0,
      errorRateScope:
        "All samples passed; any failure aborts this command and cannot produce a successful report",
      wireEvidence: jsonEvidence(wireEvidence),
      modelExecutions,
      path: {
        kind: pathKind,
        gatewaySourceRevision: gatewaySourceRevision ?? null,
      },
      providerQueueMs: null,
      providerQueueAvailability: "not reported by this transport",
      acousticFirstAudioMs: null,
      acousticAvailability:
        "this command exercises text chat, not a voice renderer",
      firstVisibleTextMs: distribution(
        turns.flatMap((turn) =>
          turn.firstVisibleTextMs === null ? [] : [turn.firstVisibleTextMs],
        ),
      ),
      execution:
        "production generateChatResponse path with streaming, persistence, and distinct proof validation",
      warmups: warmupCount,
      samples: sampleCount,
      registeredProviders: registeredProviderNames,
      wallMs: distribution(turns.map((turn) => turn.wallMs)),
      wallMsBoundary:
        "generateChatResponse command return including its room post-delivery drain",
      backgroundQuiescenceBoundary:
        "additional residual drain after generateChatResponse already drained room tasks",
      wireAttemptStats: {
        total: wireEvidence.length,
        http429: wireEvidence.filter((wire) => wire.status === 429).length,
        transportErrors: wireEvidence.filter((wire) => wire.outcome === "error")
          .length,
      },
      backgroundQuiescenceMs: distribution(
        turns.map((turn) => turn.backgroundQuiescenceMs),
      ),
      totalToQuiescenceMs: distribution(
        turns.map((turn) => turn.totalToQuiescenceMs),
      ),
      promptCache: promptCacheTelemetry(
        turns.flatMap((turn) =>
          turn.modelUsages.map((modelUsage) => ({ modelUsage })),
        ),
      ),
      stageHistograms: stageHistograms(chatTelemetry.flows),
      derivedHistograms: chatTelemetry.derivedHistograms satisfies Record<
        string,
        InferenceHistogramSummary
      >,
      spanHistograms: chatTelemetry.spanHistograms,
      providerTelemetry: chatTelemetry.providers,
      modelInputs,
      concurrentRoomRecall: {
        priming: isolationPriming,
        resumption: isolationResumption,
      },
      cancellationProbe,
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
    if (reportPath)
      await writeFile(reportPath, json, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    // error-policy:J1 Preserve the failed run as evidence before CLI failure translation.
    const reportPath = process.env.ELIZA_CEREBRAS_CHAT_REPORT?.trim();
    if (reportPath) {
      await writeFile(
        reportPath,
        `${JSON.stringify(
          jsonEvidence({
            status: "failed",
            sourceRevision,
            model,
            pathKind,
            condition,
            cacheMode,
            embedding: { ...embedding, nativeProvenance },
            wireEvidence,
            error: error instanceof Error ? error.message : String(error),
          }),
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
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
