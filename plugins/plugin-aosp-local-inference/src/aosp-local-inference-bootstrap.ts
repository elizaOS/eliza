/**
 * AOSP-only local-inference handler bootstrap for the mobile agent bundle.
 *
 * Background: the upstream `startEliza()` in `runtime/eliza.ts` does not call
 * any local-inference wiring — that lives in the `@elizaos/app-core`
 * runtime wrapper (`ensure-local-inference-handler.ts`), which the mobile
 * agent bundle does NOT import. As a result, on AOSP the runtime boots
 * with `ELIZA_LOCAL_LLAMA=1` set but no TEXT_SMALL / TEXT_LARGE /
 * TEXT_EMBEDDING handler registered, and chat fails with
 *   "No handler found for delegate type: TEXT_SMALL"
 *
 * This module is a minimal, agent-package-local replacement for the AOSP
 * branch of `ensure-local-inference-handler.ts`. It builds the fused
 * `libelizainference` FFI loader (`tryBuildAospFusedTextLoader`) — the sole
 * text/voice native backend on AOSP — and wires the ModelType handlers the
 * runtime needs. No assignments, no model registry, no routing-policy —
 * single loader, single model (resolved/auto-downloaded then loaded on first
 * call).
 *
 * Why not import from `@elizaos/app-core` directly? `@elizaos/app-core`
 * already depends on `@elizaos/agent`, so an `agent → app-core` import
 * creates a hard cyclic workspace dependency that breaks `bun install`
 * and CI even when the bundler can inline the cycle. Keeping the AOSP
 * registration here avoids the cycle entirely.
 *
 * Activation: only fires when `ELIZA_LOCAL_LLAMA === "1"`, which is
 * the AOSP build flag set by `ElizaAgentService.java` before
 * `Runtime.exec`'ing the bun process. On every other build the call logs that
 * local registration was skipped.
 */

import {
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AgentRuntime,
  applyBackgroundInferenceBudget,
  type GenerateTextParams,
  getInferencePriorityGate,
  type IAgentRuntime,
  InferenceBackgroundWaitTimeoutError,
  logger,
  ModelType,
  resolveBackgroundInferenceBudget,
  resolveStateDir,
  type TextEmbeddingParams,
  type TextToSpeechParams,
  type TranscriptionParams,
} from "@elizaos/core";
// @elizaos/shared/local-inference is no longer imported here: every AOSP TTS
// path now flows through `makeAospFusedKokoroTextToSpeechHandler` below,
// which dlopen's `libelizainference.so` via bun:ffi and synthesizes Kokoro
// TTS in-process through the fused `eliza_inference_kokoro_*` ABI.
import { writeAospLlamaDebugLog } from "./aosp-debug-log.js";
import {
  isAospEnabled,
  resolveAospElizaInferenceLibPath,
} from "./aosp-llama-paths.js";
import {
  type AospFfiPointerHelpers,
  type AospFusedLlmSymbols,
  type AospFusedStreamingLlmBinding,
  type AospLlmStreamConfig,
  createAospStreamingLlmBinding,
  streamGenerate,
} from "./aosp-llama-streaming.js";
import {
  classifyInferenceRamClass,
  InferenceIdleUnloader,
  makeProcMeminfoPressureCheck,
  resolveInferenceIdleUnloadMs,
} from "./inference-memory-policy.js";

const SERVICE_NAME = "localInferenceLoader";
const PROVIDER = "eliza-aosp-llama";
const registeredRuntimes = new WeakSet<AgentRuntime>();
const AOSP_ACTIVE_MODEL_STATE_FILE = "aosp-active.json";
let routeActivationLoader: AospLoader | null = null;

/**
 * Same priority band as cloud / direct provider plugins. Routing-policy
 * sits at MAX_SAFE_INTEGER and decides between candidates per-request;
 * this number only controls whether `runtime.getModel(TEXT_SMALL)` finds
 * a handler at all when no router is installed.
 *
 * Mirrors `ensure-local-inference-handler.ts:LOCAL_INFERENCE_PRIORITY`.
 */
const LOCAL_INFERENCE_PRIORITY = 0;

export interface AospLoader {
  loadModel(args: AospLoadModelArgs): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
    grammar?: string;
    onTextChunk?: (chunk: string) => void | Promise<void>;
    stopOnFirstSentence?: boolean;
    minFirstSentenceChars?: number;
    /**
     * Per-request abort signal. Forwarded into the fused streaming decode
     * loop (`streamGenerate`); the loop checks `signal.aborted` between
     * steps and cancels the native stream when the caller aborts.
     */
    signal?: AbortSignal;
  }): Promise<string>;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}

/**
 * Route every model-touching loader call through the idle unloader's
 * in-flight tracking (#11760): a use in flight blocks the idle unload, and
 * completion refreshes the idle clock. `unloadModel` passes through untracked
 * — an explicit unload IS the idle path's goal, and the voice handlers'
 * out-of-band eviction must never be counted as model use.
 */
export function instrumentLoaderForIdleTracking(
  loader: AospLoader,
  unloader: InferenceIdleUnloader,
): AospLoader {
  const track =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const endUse = unloader.beginUse();
      try {
        return await fn(...args);
      } finally {
        endUse();
      }
    };
  return {
    currentModelPath: () => loader.currentModelPath(),
    loadModel: track(loader.loadModel.bind(loader)),
    unloadModel: () => loader.unloadModel(),
    generate: track(loader.generate.bind(loader)),
    embed: track(loader.embed.bind(loader)),
  };
}

function writeAospActiveModelState(
  state:
    | {
        status: "ready";
        role: "chat" | "embedding";
        provider: typeof PROVIDER;
        path: string;
        loadedAt: string;
      }
    | {
        status: "error";
        role: "chat" | "embedding";
        provider: typeof PROVIDER;
        path: string;
        error: string;
        updatedAt: string;
      },
): void {
  try {
    const activeStatePath = path.join(
      resolveStateDir(),
      "local-inference",
      AOSP_ACTIVE_MODEL_STATE_FILE,
    );
    mkdirSync(path.dirname(activeStatePath), { recursive: true });
    writeFileSync(
      activeStatePath,
      `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    logger.warn(
      "[aosp-local-inference] Failed to write active model state:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function clearAospActiveModelState(): void {
  try {
    const activeStatePath = path.join(
      resolveStateDir(),
      "local-inference",
      AOSP_ACTIVE_MODEL_STATE_FILE,
    );
    if (existsSync(activeStatePath)) unlinkSync(activeStatePath);
  } catch (err) {
    logger.warn(
      "[aosp-local-inference] Failed to clear active model state:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** KV-cache type names the fused lib's `eliza_kv_cache_type` map accepts. */
type AospKvCacheTypeName =
  | "f16"
  | "q8_0"
  | "tbq3_0"
  | "tbq4_0"
  | "qjl1_256"
  | "q4_polar";

const AOSP_KV_CACHE_TYPE_NAMES: readonly AospKvCacheTypeName[] = [
  "f16",
  "q8_0",
  "tbq3_0",
  "tbq4_0",
  "qjl1_256",
  "q4_polar",
];

export interface AospLoadModelArgs {
  modelPath: string;
  contextSize?: number;
  maxThreads?: number;
  useGpu?: boolean;
  gpuLayers?: number;
  draftModelPath?: string;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  speculativeSamples?: number;
  mobileSpeculative?: boolean;
  cacheTypeK?: AospKvCacheTypeName;
  cacheTypeV?: AospKvCacheTypeName;
  disableThinking?: boolean;
  kvCacheType?: {
    k?: AospKvCacheTypeName;
    v?: AospKvCacheTypeName;
  };
}

export interface AospRouteActivationSnapshot {
  modelId: string | null;
  loadedAt: string | null;
  status: "idle" | "ready" | "error";
  error?: string;
  loadedContextSize?: number | null;
  loadedCacheTypeK?: string | null;
  loadedCacheTypeV?: string | null;
  loadedGpuLayers?: number | null;
}

function activeSnapshotFromLoadArgs(
  modelId: string,
  loadedAt: string,
  loadArgs: AospLoadModelArgs,
): AospRouteActivationSnapshot {
  return {
    modelId,
    loadedAt,
    status: "ready",
    loadedContextSize: loadArgs.contextSize ?? null,
    loadedCacheTypeK: loadArgs.cacheTypeK ?? loadArgs.kvCacheType?.k ?? null,
    loadedCacheTypeV: loadArgs.cacheTypeV ?? loadArgs.kvCacheType?.v ?? null,
    loadedGpuLayers:
      typeof loadArgs.gpuLayers === "number" ? loadArgs.gpuLayers : null,
  };
}

export async function activateAospLocalInferenceModel(args: {
  modelId: string;
  modelPath: string;
  loadArgs: AospLoadModelArgs;
}): Promise<AospRouteActivationSnapshot> {
  if (!routeActivationLoader) {
    throw new Error(
      "[aosp-local-inference] Native localInferenceLoader is not ready yet.",
    );
  }
  try {
    await routeActivationLoader.unloadModel();
    await routeActivationLoader.loadModel(args.loadArgs);
    const loadedAt = new Date().toISOString();
    writeAospActiveModelState({
      status: "ready",
      role: "chat",
      provider: PROVIDER,
      path: args.modelPath,
      loadedAt,
    });
    // Eagerly stage the on-device Kokoro voice when a local chat model is
    // selected/activated, so the first spoken reply already uses the neural
    // voice instead of the platform "android voice". Background + idempotent
    // (no-op if tts/kokoro/ exists or ELIZA_DISABLE_VOICE_AUTO_DOWNLOAD=1).
    ensureKokoroTtsAssetsInBackground(
      resolveBundleRootFromModelPath(args.modelPath),
      tierSlugFromModelName(path.basename(args.modelPath)),
    );
    return activeSnapshotFromLoadArgs(args.modelId, loadedAt, args.loadArgs);
  } catch (err) {
    writeAospActiveModelState({
      status: "error",
      role: "chat",
      provider: PROVIDER,
      path: args.modelPath,
      error: err instanceof Error ? err.message : String(err),
      updatedAt: new Date().toISOString(),
    });
    throw err;
  }
}

export async function clearAospLocalInferenceModel(): Promise<AospRouteActivationSnapshot> {
  if (routeActivationLoader) {
    await routeActivationLoader.unloadModel();
  }
  clearAospActiveModelState();
  return { modelId: null, loadedAt: null, status: "idle" };
}

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

type EmbeddingHandler = (
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
) => Promise<number[]>;

type TextToSpeechHandler = (
  runtime: IAgentRuntime,
  params: TextToSpeechParams | string,
) => Promise<Uint8Array>;

interface AospKokoroPrewarmOptions {
  shouldSkip?: () => boolean;
}

interface AospFusedKokoroConfig {
  libPath: string;
  bundleRoot: string;
  kokoroGgufPath: string;
  kokoroVoicePath: string;
}

type TranscriptionHandler = (
  runtime: IAgentRuntime,
  params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
) => Promise<string>;

interface LocalTranscriptionParams {
  pcm?: Float32Array;
  audio?: Uint8Array | ArrayBuffer | Buffer;
  sampleRateHz?: number;
  sampleRate?: number;
  signal?: AbortSignal;
}

function renderMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part.trim();
      if (
        part &&
        typeof part === "object" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeChatRole(
  role: unknown,
): "system" | "user" | "assistant" | "tool" {
  return role === "system" ||
    role === "assistant" ||
    role === "user" ||
    role === "tool"
    ? role
    : "user";
}

/**
 * Render core GenerateTextParams into the flat prompt string consumed by the
 * fused bun:ffi backend. v5 Stage-1 calls pass native chat `messages`
 * and leave legacy `prompt` unset; without this bridge the native loader sees
 * an empty string and `eliza_inference_tokenize` returns zero tokens.
 *
 * The Eliza-1 bundle is a Gemma 4 model, so we render the Gemma turn template
 * (`<start_of_turn>role\n…<end_of_turn>`) with a trailing
 * `<start_of_turn>model` generation marker. The generate path MUST tokenize
 * this with parse_special=true so the turn delimiters become real control
 * tokens instead of literal text the model parrots back, and stops on
 * `<end_of_turn>`.
 */
const GEMMA_START_OF_TURN = "<start_of_turn>";
const GEMMA_END_OF_TURN = "<end_of_turn>";

function gemmaRole(role: "system" | "user" | "assistant" | "tool"): string {
  return role === "assistant" ? "model" : role;
}

export function flattenGenerateTextParamsForAospPrompt(
  params: GenerateTextParams,
): string {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }

  const gemmaBlock = (
    role: "system" | "user" | "assistant" | "tool",
    content: string,
  ) =>
    `${GEMMA_START_OF_TURN}${gemmaRole(role)}\n${content}${GEMMA_END_OF_TURN}`;

  const messages = params.messages ?? [];
  if (messages.length > 0) {
    const blocks: string[] = [];
    const hasSystemMessage = messages.some(
      (message) => message.role === "system",
    );
    if (
      !hasSystemMessage &&
      typeof params.system === "string" &&
      params.system
    ) {
      blocks.push(gemmaBlock("system", params.system.trim()));
    }
    for (const message of messages) {
      const content = renderMessageContent(message.content);
      if (!content) continue;
      blocks.push(gemmaBlock(normalizeChatRole(message.role), content));
    }
    if (blocks.length > 0) {
      const lastRole = normalizeChatRole(messages[messages.length - 1]?.role);
      if (lastRole !== "assistant") {
        blocks.push(`${GEMMA_START_OF_TURN}model\n`);
      }
      return blocks.join("\n");
    }
  }

  const promptFromSegments =
    params.promptSegments && params.promptSegments.length > 0
      ? params.promptSegments.map((segment) => segment.content ?? "").join("")
      : "";
  if (promptFromSegments.length > 0) {
    return promptFromSegments;
  }

  if (typeof params.system === "string" && params.system.length > 0) {
    return `${gemmaBlock("system", params.system.trim())}\n${GEMMA_START_OF_TURN}model\n`;
  }

  return "";
}

export function buildGenerateArgsFromParams(
  params: GenerateTextParams,
): Parameters<AospLoader["generate"]>[0] {
  const args: Parameters<AospLoader["generate"]>[0] = {
    prompt: flattenGenerateTextParamsForAospPrompt(params),
  };
  // Always stop at Gemma turn boundaries. With parse_special=true the model's
  // <end_of_turn> is its EOG token (the fused stream ends the turn on it), but
  // the text stops are a belt-and-suspenders guard against the model
  // continuing past its turn or opening a new <start_of_turn> role.
  args.stopSequences = [
    ...(params.stopSequences ?? []),
    GEMMA_END_OF_TURN,
    GEMMA_START_OF_TURN,
  ];
  if (params.maxTokens !== undefined) {
    args.maxTokens = params.maxTokens;
  }
  if (params.temperature !== undefined) {
    args.temperature = params.temperature;
  }
  if (typeof params.grammar === "string" && params.grammar.trim().length > 0) {
    args.grammar = params.grammar;
  }
  const wantsStreaming =
    params.stream === true || params.streamStructured === true;
  if (wantsStreaming && typeof params.onStreamChunk === "function") {
    args.onTextChunk = (chunk: string) => params.onStreamChunk?.(chunk);
  }
  const androidLocalOptions =
    params.providerOptions?.androidLocal &&
    typeof params.providerOptions.androidLocal === "object" &&
    !Array.isArray(params.providerOptions.androidLocal)
      ? (params.providerOptions.androidLocal as Record<string, unknown>)
      : null;
  if (androidLocalOptions?.stopOnFirstSentence === true) {
    args.stopOnFirstSentence = true;
  }
  const minFirstSentenceChars =
    typeof androidLocalOptions?.minFirstSentenceChars === "number"
      ? androidLocalOptions.minFirstSentenceChars
      : Number.NaN;
  if (Number.isFinite(minFirstSentenceChars) && minFirstSentenceChars > 0) {
    args.minFirstSentenceChars = Math.floor(minFirstSentenceChars);
  }
  if (params.signal !== undefined) {
    args.signal = params.signal;
  }
  return args;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Chat KV-cache type override (`ELIZA_LLAMA_KV_TYPE_K` / `_V`). The fork
 * defaults (q8_0 / f16) are eliza-1's Gemma-safe memory policy: q8_0 halves the
 * K cache, while f16 avoids the fused-lib flash-attn requirement for V-quant.
 * The env knob lets a device profile pin another supported type without a
 * rebuild.
 */
function readKvCacheTypeEnv(
  name: string,
  fallback: AospKvCacheTypeName,
): AospKvCacheTypeName {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  const match = AOSP_KV_CACHE_TYPE_NAMES.find((candidate) => candidate === raw);
  if (!match) {
    logger.warn(
      `[aosp-local-inference] ${name}="${raw}" is not a recognised KV cache type (accepted: ${AOSP_KV_CACHE_TYPE_NAMES.join(", ")}); using ${fallback}`,
    );
    return fallback;
  }
  return match;
}

function readNonNegativeIntEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function isAospLocalEmbeddingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.ELIZA_LOCAL_EMBEDDING_ENABLED?.trim() === "1";
}

export function disabledAospEmbeddingVector(
  env: NodeJS.ProcessEnv = process.env,
): number[] {
  const dimensions =
    readPositiveIntEnvFrom(env, "ELIZA_LOCAL_EMBEDDING_DIMENSIONS", 0) ||
    readPositiveIntEnvFrom(env, "LOCAL_EMBEDDING_DIMENSIONS", 0) ||
    readPositiveIntEnvFrom(env, "EMBEDDING_DIMENSION", 384);
  return Array.from({ length: dimensions }, () => 0);
}

function readPositiveIntEnvFrom(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBooleanEnv(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") {
    return true;
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
    return false;
  }
  return null;
}

function resolveAospLlamaGpuLayers(): number {
  const explicitLayers = readNonNegativeIntEnv("ELIZA_LLAMA_N_GPU_LAYERS");
  if (explicitLayers !== null) return explicitLayers;
  const useGpu = readBooleanEnv("ELIZA_AOSP_LLAMA_USE_GPU");
  return useGpu === true ? 99 : 0;
}

function mtpServerSpawnAllowed(): boolean {
  const explicitServerSpawn = readBooleanEnv("ELIZA_MTP_SERVER_SPAWN");
  if (explicitServerSpawn !== null) {
    return explicitServerSpawn;
  }

  // ELIZA_MTP expresses the desired inference mode. It must not opt a
  // stock APK into the retired child-process llama-server path. Android
  // production builds only enable speculation through an in-process FFI
  // implementation that explicitly reports support; server spawn is a
  // diagnostic escape hatch and requires ELIZA_MTP_SERVER_SPAWN=1.
  return false;
}

function inProcessMtpRequested(): boolean {
  const explicitMtp = readBooleanEnv("ELIZA_MTP");
  if (explicitMtp !== null) {
    return explicitMtp;
  }
  return readBooleanEnv("ELIZA_MTP_REQUIRED") === true;
}

function mtpDrafterIsTargetCopy(bundleDir: string): boolean {
  const raw = readMtpTargetMeta(bundleDir);
  if (!raw) return false;
  const draftSha =
    typeof raw.drafter?.sha256 === "string"
      ? raw.drafter.sha256.trim().toLowerCase()
      : "";
  const targetSha =
    typeof raw.targetText?.sha256 === "string"
      ? raw.targetText.sha256.trim().toLowerCase()
      : "";
  return Boolean(draftSha && targetSha && draftSha === targetSha);
}

function readMtpTargetMeta(bundleDir: string): {
  publishEligible?: unknown;
  drafter?: {
    sha256?: unknown;
    sizeBytes?: unknown;
    finalElizaWeights?: unknown;
  };
  targetText?: {
    sha256?: unknown;
    sizeBytes?: unknown;
    finalElizaWeights?: unknown;
  };
  validation?: {
    checks?: Record<string, { pass?: unknown } | undefined>;
  };
} | null {
  const metaPath = path.join(bundleDir, "mtp", "target-meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (err) {
    writeAospLlamaDebugLog("bootstrap:mtp:targetMetaReadFailed", {
      metaPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function mtpMetadataAllowsStockAutoPair(bundleDir: string): boolean {
  const meta = readMtpTargetMeta(bundleDir);
  if (meta?.publishEligible !== true) return false;
  if (mtpDrafterIsTargetCopy(bundleDir)) return false;
  if (
    meta.drafter?.finalElizaWeights === false ||
    meta.targetText?.finalElizaWeights === false
  ) {
    return false;
  }
  const draftSize =
    typeof meta.drafter?.sizeBytes === "number" ? meta.drafter.sizeBytes : 0;
  const targetSize =
    typeof meta.targetText?.sizeBytes === "number"
      ? meta.targetText.sizeBytes
      : 0;
  if (draftSize > 0 && targetSize > 0 && draftSize >= targetSize) return false;
  const checks = meta.validation?.checks ?? {};
  for (const name of [
    "architectureLoadable",
    "vocabMatch",
    "tokenizerMetadataMatch",
    "drafterSmaller",
  ]) {
    if (checks[name]?.pass === false) return false;
  }
  return true;
}

function resolveMtpDrafterPath(modelPath: string): string | null {
  const explicit = process.env.ELIZA_MTP_DRAFTER_PATH?.trim();
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  const textDir = path.dirname(modelPath);
  const bundleDir =
    path.basename(textDir).toLowerCase() === "text"
      ? path.dirname(textDir)
      : path.dirname(modelPath);
  const mtpDir = path.join(bundleDir, "mtp");
  if (!existsSync(mtpDir)) return null;
  const explicitlyRequested =
    inProcessMtpRequested() || mtpServerSpawnAllowed();
  const explicitlyDisabled = readBooleanEnv("ELIZA_MTP") === false;
  if (
    !explicitlyRequested &&
    (explicitlyDisabled || !mtpMetadataAllowsStockAutoPair(bundleDir))
  ) {
    return null;
  }
  if (mtpDrafterIsTargetCopy(bundleDir)) {
    writeAospLlamaDebugLog("bootstrap:mtp:skip", {
      reason: "drafter_sha_matches_target",
      bundleDir,
    });
    return null;
  }
  try {
    const candidates = readdirSync(mtpDir)
      .filter((name) => {
        const lower = name.toLowerCase();
        return lower.endsWith(".gguf") && lower.includes("draft");
      })
      .sort();
    for (const name of candidates) {
      const candidate = path.join(mtpDir, name);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildAospLoadModelArgs(
  role: "chat" | "embedding",
  modelPath: string,
): AospLoadModelArgs {
  if (role === "chat") {
    const draftModelPath = resolveMtpDrafterPath(modelPath);
    const gpuLayers = resolveAospLlamaGpuLayers();
    return {
      modelPath,
      contextSize: readPositiveIntEnv("ELIZA_LLAMA_N_CTX", 4096),
      draftModelPath: draftModelPath ?? undefined,
      draftContextSize: draftModelPath
        ? readPositiveIntEnv("ELIZA_MTP_DRAFT_N_CTX", 2048)
        : undefined,
      draftMin: draftModelPath
        ? readPositiveIntEnv("ELIZA_MTP_DRAFT_MIN", 1)
        : undefined,
      draftMax: draftModelPath
        ? readPositiveIntEnv("ELIZA_MTP_DRAFT_MAX", 16)
        : undefined,
      useGpu: gpuLayers > 0,
      gpuLayers,
      // Gemma-4 KV path (#11760): the QJL/PolarQuant kernels are retired for
      // the shipped eliza-1 tiers (#8848/#9033 cutover — Gemma's dual head
      // dims are incompatible), and current fused libs route the legacy names
      // into the stock V-quant check, which hard-fails without flash-attn
      // (disabled on Android: scalar-FA race). K=q8_0 halves the K cache and
      // needs no FA; V stays f16 (V-quant requires FA). Matches the bionic
      // host's KV decision (ELIZA_BIONIC_KV_QUANT=0) and the catalog's
      // ELIZA_1_KV_QUANT=q8_0.
      kvCacheType: {
        k: readKvCacheTypeEnv("ELIZA_LLAMA_KV_TYPE_K", "q8_0"),
        v: readKvCacheTypeEnv("ELIZA_LLAMA_KV_TYPE_V", "f16"),
      },
    };
  }
  return {
    modelPath,
    contextSize: readPositiveIntEnv("ELIZA_LLAMA_EMBEDDING_N_CTX", 512),
    useGpu: false,
    gpuLayers: 0,
    kvCacheType: {
      k: "f16",
      v: "f16",
    },
  };
}

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (
    modelType: string | number,
  ) =>
    | GenerateTextHandler
    | EmbeddingHandler
    | TextToSpeechHandler
    | TranscriptionHandler
    | undefined;
  registerModel: (
    modelType: string | number,
    handler:
      | GenerateTextHandler
      | EmbeddingHandler
      | TextToSpeechHandler
      | TranscriptionHandler,
    provider: string,
    priority?: number,
  ) => void;
};

/**
 * Cloud-fallback priority. Sits one below the local handler's
 * `LOCAL_INFERENCE_PRIORITY = 0`, so the runtime resolves local first
 * and only consults the wrapper when local isn't registered OR when the
 * local handler itself explicitly delegates via `findCloudCandidate`.
 *
 * The wrapper is INDEPENDENTLY registered at -1 so callers that call
 * `runtime.useModel(TEXT_LARGE)` with no provider hint still resolve
 * the local path; the wrapper provides a SECOND chance when local
 * throws a known-recoverable error.
 */
const CLOUD_FALLBACK_PRIORITY = -1;

/**
 * Typed outcome of a local-inference attempt. The wrapper distinguishes
 * "succeeded" from "decided to fall back" via an EXPLICIT shape — no
 * silent try/catch. Unrecoverable errors propagate; only the conditions
 * listed in `FallbackReason` route to cloud.
 */
type FallbackReason =
  | "local-unavailable"
  | "local-overloaded"
  | "local-error"
  | "local-aborted-pre-completion";

type LocalGenerateOutcome =
  | { kind: "ok"; text: string }
  | { kind: "fallback"; reason: FallbackReason; cause?: Error };

/**
 * Classify a thrown error into either "let it propagate" or "rotate to
 * cloud". Mirrors `packages/app-core/src/services/local-inference/cloud-fallback.ts`
 * but inlined here because the AOSP bundle deliberately does NOT import
 * `@elizaos/app-core` (cycle through `@elizaos/agent`).
 */
function classifyLocalError(err: unknown): {
  fallback: boolean;
  reason: FallbackReason;
} {
  if (err instanceof Error) {
    const name = err.name;
    const msg = err.message.toLowerCase();
    if (name === "AbortError") {
      return { fallback: false, reason: "local-aborted-pre-completion" };
    }
    if (err instanceof InferenceBackgroundWaitTimeoutError) {
      // The local lane was busy for the whole bounded background wait
      // (#11914) — the job never started locally, so a configured cloud
      // handler may run it instead.
      return { fallback: true, reason: "local-overloaded" };
    }
    if (
      msg.includes("no bundled") ||
      msg.includes("not installed in this build") ||
      msg.includes("no local model is active") ||
      msg.includes("dlopen") ||
      msg.includes("fused libelizainference") ||
      msg.includes("streaming-llm") ||
      msg.includes("aosp-local-inference] no") ||
      msg.includes("called before loadmodel")
    ) {
      return { fallback: true, reason: "local-unavailable" };
    }
    if (
      msg.includes("decode: failed to find a memory slot") ||
      msg.includes("thermal") ||
      msg.includes("low-power")
    ) {
      return { fallback: true, reason: "local-overloaded" };
    }
    if (
      msg.includes("llm_stream_") ||
      msg.includes("fused tokenize") ||
      msg.includes("fused embed") ||
      msg.includes("ggml_assert")
    ) {
      return { fallback: true, reason: "local-error" };
    }
  }
  return { fallback: false, reason: "local-error" };
}

/**
 * Locate the highest-priority registered TEXT_* handler whose provider is
 * NOT us. The runtime exposes its `models` map on the prototype; we read it
 * defensively so changes to the registry shape surface as a typed lookup
 * failure rather than a silent miss.
 */
interface CloudCandidate {
  provider: string;
  priority: number;
  handler: GenerateTextHandler;
}

function findCloudCandidate(
  runtime: IAgentRuntime,
  modelType: (typeof ModelType)[keyof typeof ModelType],
  excludeProvider: string,
): CloudCandidate | null {
  const r = runtime as IAgentRuntime & {
    models?: Map<
      string,
      Array<{
        provider: string;
        priority: number;
        handler: GenerateTextHandler;
      }>
    >;
  };
  const entries = r.models?.get(String(modelType));
  if (!entries || entries.length === 0) return null;
  for (const entry of entries) {
    if (entry.provider !== excludeProvider) {
      return {
        provider: entry.provider,
        priority: entry.priority,
        handler: entry.handler,
      };
    }
  }
  return null;
}

interface RuntimeWithRegisterService {
  registerService?: (name: string, impl: unknown) => unknown;
}

/**
 * Register the fused-libelizainference loader as the `localInferenceLoader`
 * runtime service.
 *
 * The fused `libelizainference.so` is the SOLE text/voice native library on
 * AOSP: `eliza_inference_llm_stream_*` for streaming text generation (with
 * same-file MTP speculative decoding + KV-quant), `eliza_inference_tokenize` /
 * `eliza_inference_embed` for the embedding slot. There is no `libllama.so`
 * fallback — when the fused lib is absent or pre-v9 this returns false and the
 * caller surfaces a loud local-unavailable failure.
 *
 * Returns true when the fused loader was built + registered, false otherwise.
 * Kept as a named export because `@elizaos/agent`'s mobile bootstrap and
 * `@elizaos/plugin-local-inference`'s `ensure-local-inference-handler.ts`
 * dynamically import it to wire the `localInferenceLoader` service.
 */
export async function registerAospLlamaLoader(
  runtime: RuntimeWithRegisterService,
): Promise<boolean> {
  if (!isAospEnabled()) return false;
  if (typeof runtime.registerService !== "function") return false;
  const loader = await tryBuildAospFusedTextLoader();
  if (!loader) {
    logger.error(
      "[aosp-local-inference] fused libelizainference text loader unavailable (lib absent or pre-ABI-v9); localInferenceLoader NOT registered.",
    );
    return false;
  }
  runtime.registerService(SERVICE_NAME, loader);
  logger.info(
    "[aosp-local-inference] Registered fused libelizainference localInferenceLoader (ELIZA_LOCAL_LLAMA=1)",
  );
  return true;
}

/**
 * Resolve the bundled chat / embedding GGUF paths shipped under
 * `$ELIZA_STATE_DIR/local-inference/models/`. Both files are staged by
 * the AOSP build (`scripts/elizaos/stage-default-models.mjs`) and
 * extracted by `ElizaAgentService.extractAssetsIfNeeded` before bun
 * starts. We pick the role from the sibling `manifest.json` so model bundle
 * swaps do not need code changes.
 */
interface BundledModelManifestEntry {
  // The build-time staging script (`scripts/elizaos/stage-default-models.mjs`)
  // writes `ggufFile` (the on-disk filename relative to the models dir).
  // Older manifests used `filename`; we read both for forward-compat.
  ggufFile?: string;
  filename?: string;
  role: "chat" | "embedding";
}

interface LocalInferenceAssignmentsFile {
  assignments?: Record<string, string | undefined>;
}

interface LocalInferenceRegistryEntry {
  id?: string;
  path?: string;
  bundleRoot?: string;
}

interface LocalInferenceRegistryFile {
  models?: LocalInferenceRegistryEntry[];
}

function readJsonFile<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function mapExistingModelPath(raw: unknown, modelsDir: string): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const candidate = raw.trim();
  const normalized = candidate.replaceAll("\\", "/");
  // Container-relative rows (the canonical registry format since #11669) are
  // stored relative to the local-inference dir — the parent of modelsDir.
  if (!path.isAbsolute(candidate) && !/^[A-Za-z]:[\\/]/.test(candidate)) {
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
      return null;
    }
    const mapped = path.join(path.dirname(modelsDir), ...parts);
    return existsSync(mapped) ? mapped : null;
  }
  // Legacy absolute rows from a previous container/state root: re-anchor by
  // the `/local-inference/models/` suffix.
  const marker = "/local-inference/models/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const relative = normalized.slice(markerIndex + marker.length);
    const mapped = path.join(modelsDir, ...relative.split("/").filter(Boolean));
    if (existsSync(mapped)) return mapped;
  }
  return existsSync(candidate) ? candidate : null;
}

function isChatModelPath(file: string): boolean {
  const lowerPath = file.replaceAll("\\", "/").toLowerCase();
  const lowerName = path.basename(file).toLowerCase();
  return (
    lowerName.endsWith(".gguf") &&
    lowerName.includes("eliza-1") &&
    !lowerPath.includes("/mtp/") &&
    !lowerPath.includes("/tts/") &&
    !lowerPath.includes("/asr/") &&
    !lowerPath.includes("/vad/") &&
    !lowerName.includes("drafter") &&
    !lowerName.includes("mmproj")
  );
}

function isEmbeddingModelPath(file: string): boolean {
  const lowerPath = file.replaceAll("\\", "/").toLowerCase();
  const lowerName = path.basename(file).toLowerCase();
  return (
    lowerName.endsWith(".gguf") &&
    (lowerPath.includes("embedding") || lowerName.includes("bge"))
  );
}

function findModelUnderDirectory(
  root: string,
  role: "chat" | "embedding",
): string | null {
  if (!existsSync(root)) return null;
  const matcher = role === "chat" ? isChatModelPath : isEmbeddingModelPath;
  const visit = (dir: string, depth: number): string | null => {
    if (depth > 4) return null;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return null;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(abs);
      } catch {
        continue;
      }
      if (stats.isFile() && matcher(abs)) return abs;
      if (stats.isDirectory()) {
        const found = visit(abs, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root, 0);
}

function resolveAssignedRegistryModel(
  registry: LocalInferenceRegistryFile | null,
  modelId: string | undefined,
  role: "chat" | "embedding",
  modelsDir: string,
): string | null {
  if (!modelId) return null;
  const entry = registry?.models?.find((model) => model.id === modelId);
  if (!entry) return null;
  const direct = mapExistingModelPath(entry.path, modelsDir);
  if (
    direct &&
    (role === "chat" ? isChatModelPath(direct) : isEmbeddingModelPath(direct))
  ) {
    return direct;
  }
  const bundleRoot = mapExistingModelPath(entry.bundleRoot, modelsDir);
  if (!bundleRoot) return null;
  return findModelUnderDirectory(bundleRoot, role);
}

export function readAssignedBundledModels(modelsDir: string): {
  chat: string | null;
  embedding: string | null;
} {
  const localInferenceDir = path.dirname(modelsDir);
  const assignments = readJsonFile<LocalInferenceAssignmentsFile>(
    path.join(localInferenceDir, "assignments.json"),
  )?.assignments;
  if (!assignments) return { chat: null, embedding: null };
  const registry = readJsonFile<LocalInferenceRegistryFile>(
    path.join(localInferenceDir, "registry.json"),
  );
  return {
    chat:
      resolveAssignedRegistryModel(
        registry,
        assignments.TEXT_SMALL ?? assignments.TEXT_LARGE,
        "chat",
        modelsDir,
      ) ??
      resolveAssignedRegistryModel(
        registry,
        assignments.TEXT_LARGE,
        "chat",
        modelsDir,
      ),
    embedding: resolveAssignedRegistryModel(
      registry,
      assignments.TEXT_EMBEDDING,
      "embedding",
      modelsDir,
    ),
  };
}

function readBundledModelManifest(modelsDir: string): {
  chat: string | null;
  embedding: string | null;
} {
  const manifestPath = path.join(modelsDir, "manifest.json");
  if (!existsSync(manifestPath)) return { chat: null, embedding: null };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      models?: BundledModelManifestEntry[];
    };
    let chat: string | null = null;
    let embedding: string | null = null;
    for (const entry of parsed.models ?? []) {
      const fileName = entry.ggufFile ?? entry.filename;
      if (!fileName) continue;
      const abs = path.join(modelsDir, fileName);
      if (!existsSync(abs)) continue;
      if (entry.role === "chat" && !chat) chat = abs;
      else if (entry.role === "embedding" && !embedding) embedding = abs;
    }
    return { chat, embedding };
  } catch (err) {
    logger.error(
      "[aosp-local-inference] Could not parse manifest.json:",
      err instanceof Error ? err.message : String(err),
    );
    return { chat: null, embedding: null };
  }
}

// Recommended-model auto-download for the AOSP / bun:ffi path. Mirrors
// the helper in plugin-capacitor-bridge/mobile-device-bridge-bootstrap.ts:
// when no GGUF is staged on the device, fetch a known-good default from
// HuggingFace into the agent state dir so first-chat-works without
// requiring a manual `stage-default-models.mjs + APK rebuild` round.
//
// `ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1` opts out for offline / kiosk
// builds — callers see the original "stage one via stage-default-models"
// error in that mode.
type AospRecommendedModel = {
  id: string;
  hfRepo: string;
  ggufFile: string;
  expectedSizeBytes?: number;
};

const AOSP_RECOMMENDED_MODELS: Record<
  "chat" | "embedding",
  AospRecommendedModel
> = {
  chat: {
    // The quantized 2B is the shipped mobile default chat model: entry tier,
    // fits 8 GB-class phones, downloads fast, and is the model bundled into the
    // AOSP image. Mirrors the capacitor bridge and the catalog
    // FIRST_RUN_DEFAULT_MODEL_ID.
    id: "eliza-1-2b",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "bundles/2b/text/eliza-1-2b-128k.gguf",
  },
  embedding: {
    id: "eliza-1-embedding",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "bundles/4b/embedding/eliza-1-embedding.gguf",
  },
};

const aospInflightDownloads = new Map<string, Promise<string>>();

async function downloadRecommendedAospModel(
  role: "chat" | "embedding",
  modelsDir: string,
): Promise<string> {
  const model = AOSP_RECOMMENDED_MODELS[role];
  mkdirSync(modelsDir, { recursive: true });
  const finalPath = path.join(modelsDir, model.ggufFile);
  mkdirSync(path.dirname(finalPath), { recursive: true });
  if (existsSync(finalPath)) {
    const sz = statSync(finalPath).size;
    if (!model.expectedSizeBytes || sz === model.expectedSizeBytes) {
      return finalPath;
    }
    logger.warn(
      `[aosp-local-inference] ${model.ggufFile} present but size ${sz} != expected ${model.expectedSizeBytes}; re-downloading.`,
    );
    try {
      unlinkSync(finalPath);
    } catch {}
  }
  const dedupKey = `${role}:${model.id}`;
  const existing = aospInflightDownloads.get(dedupKey);
  if (existing) return existing;
  const promise = (async () => {
    const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.ggufFile}`;
    const stagingPath = `${finalPath}.part`;
    try {
      unlinkSync(stagingPath);
    } catch {}
    logger.info(
      `[aosp-local-inference] Auto-downloading recommended ${role} model ${model.id} from ${url}`,
    );
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(
        `[aosp-local-inference] Recommended-model download failed (${role}): HTTP ${response.status} ${response.statusText} from ${url}`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(stagingPath),
    );
    const stagedSize = statSync(stagingPath).size;
    if (model.expectedSizeBytes && stagedSize !== model.expectedSizeBytes) {
      try {
        unlinkSync(stagingPath);
      } catch {}
      throw new Error(
        `[aosp-local-inference] Downloaded ${model.ggufFile} size ${stagedSize} != expected ${model.expectedSizeBytes}.`,
      );
    }
    renameSync(stagingPath, finalPath);
    logger.info(
      `[aosp-local-inference] Auto-download complete: ${finalPath} (${stagedSize} bytes)`,
    );
    return finalPath;
  })();
  aospInflightDownloads.set(dedupKey, promise);
  try {
    return await promise;
  } finally {
    aospInflightDownloads.delete(dedupKey);
  }
}

function resolveBundledModelsDir(): string {
  return path.join(resolveStateDir(), "local-inference", "models");
}

// Kokoro-82M is the small/fast on-device voice — the only on-device TTS
// backend. It isn't always bundled into
// the APK, so fetch the acoustic GGUF + the af_sam speaker preset into the
// bundle's `tts/kokoro/` dir — the exact dir ElizaBionicInferenceServer.tts()
// and the fused Kokoro loader read. The on-device voice is an ESSENTIAL feature
// (without it the app speaks with the platform TextToSpeech — the "android
// voice"), so unlike the general recommended-model auto-download it fetches by
// default; opt out with ELIZA_DISABLE_VOICE_AUTO_DOWNLOAD=1 (offline/kiosk).
// `af_sam.bin` lives under voice/kokoro/voices/, not the per-tier bundle.
// The published eliza-1 bundle ships the F16 GGUF under this name (no
// separate Q4 is published; llama-quantize does not support the kokoro arch).
// The engine discovery also accepts this name — keep them in sync.
const KOKORO_GGUF_FILE = "kokoro-82m-v1_0.gguf";
const KOKORO_VOICE_FILE = "af_sam.bin";
// Kokoro style-embedding dimension (matches the shared voice/ffi-bindings loader
// and the .bin voice-preset layout). Passed to eliza_inference_kokoro_load.
const KOKORO_STYLE_DIM = 256;
let kokoroTtsDownloadInflight: Promise<void> | null = null;

// HF bundle tier slugs, longest-first so "27b-256k" matches before "27b".
const ELIZA1_TIER_SLUGS = ["27b-256k", "27b", "9b", "4b", "2b"] as const;

// Derive the HF bundle tier slug (e.g. "2b") from a chat model id or GGUF
// filename like "eliza-1-2b-128k.gguf". The Kokoro voice URL is
// `bundles/<tier>/tts/kokoro/...`; the old `path.basename(bundleRoot)`
// derivation yielded "bundle" for the on-device `<files>/eliza-1/bundle`
// layout and 404'd every Kokoro download (the device fell back to the platform
// "android voice"). Defaults to the entry tier "2b" so the URL stays valid.
function tierSlugFromModelName(modelNameOrId: string): string {
  const lower = modelNameOrId.toLowerCase();
  for (const slug of ELIZA1_TIER_SLUGS) {
    if (lower.includes(`eliza-1-${slug}`)) return slug;
  }
  return "2b";
}

// Tier slug of the currently-assigned chat bundle, for the Kokoro voice URL.
function resolveAssignedChatTierSlug(): string {
  try {
    const modelsDir = resolveBundledModelsDir();
    const assigned = readAssignedBundledModels(modelsDir);
    const manifest = readBundledModelManifest(modelsDir);
    const fallback = fallbackFindBundledModels(modelsDir);
    const chatModel = assigned.chat ?? manifest.chat ?? fallback.chat;
    return chatModel ? tierSlugFromModelName(path.basename(chatModel)) : "2b";
  } catch {
    return "2b";
  }
}

function ensureKokoroTtsAssetsInBackground(
  bundleRoot: string,
  tier: string,
): void {
  if (process.env.ELIZA_DISABLE_VOICE_AUTO_DOWNLOAD?.trim() === "1") return;
  if (kokoroTtsDownloadInflight) return;
  const kokoroDir = path.join(bundleRoot, "tts", "kokoro");
  if (existsSync(kokoroDir)) return;
  const stagingDir = path.join(bundleRoot, "tts", "kokoro.staging");
  kokoroTtsDownloadInflight = (async () => {
    removeAospGeneratedStagingDir(stagingDir, bundleRoot);
    mkdirSync(stagingDir, { recursive: true });
    const downloads: Array<{ url: string; name: string }> = [
      {
        url: `https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/${tier}/tts/kokoro/${KOKORO_GGUF_FILE}`,
        name: KOKORO_GGUF_FILE,
      },
      {
        url: `https://huggingface.co/elizaos/eliza-1/resolve/main/voice/kokoro/voices/${KOKORO_VOICE_FILE}`,
        name: KOKORO_VOICE_FILE,
      },
    ];
    for (const { url, name } of downloads) {
      logger.info(
        `[aosp-local-inference] Auto-downloading Kokoro voice ${name} from ${url}`,
      );
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(
          `Kokoro voice download failed (${name}): HTTP ${response.status} ${response.statusText}`,
        );
      }
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(path.join(stagingDir, name)),
      );
    }
    // Atomic publish: tts/kokoro/ appears only when both files are complete.
    renameSync(stagingDir, kokoroDir);
    logger.info(
      `[aosp-local-inference] Kokoro voice staged under ${kokoroDir}`,
    );
  })()
    .catch((err) => {
      logger.warn(
        `[aosp-local-inference] Kokoro voice auto-download failed (falling back to system TTS): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      removeAospGeneratedStagingDir(stagingDir, bundleRoot);
    })
    .finally(() => {
      kokoroTtsDownloadInflight = null;
    });
}

export function removeAospGeneratedStagingDir(
  stagingDir: string,
  bundleRoot: string,
): void {
  const root = path.resolve(bundleRoot);
  const target = path.resolve(stagingDir);
  if (
    !path.basename(target).endsWith(".staging") ||
    target === root ||
    target === process.cwd() ||
    target === path.parse(target).root ||
    !target.startsWith(`${root}${path.sep}`)
  ) {
    throw new Error(
      `[aosp-local-inference] Refusing to remove unsafe staging directory: ${stagingDir}`,
    );
  }
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

/**
 * Glob-fallback for missing manifest: pick the first `*.gguf` whose name
 * matches one of the well-known role prefixes. Keeps the bootstrap
 * functional even on dev images where the manifest didn't get copied.
 */
function fallbackFindBundledModels(modelsDir: string): {
  chat: string | null;
  embedding: string | null;
} {
  if (!existsSync(modelsDir)) return { chat: null, embedding: null };
  let chat: string | null = null;
  let embedding: string | null = null;
  const visit = (dir: string, depth: number): void => {
    if (depth > 4 || (chat && embedding)) return;
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      let isDirectory = false;
      let isFile = false;
      try {
        const stats = statSync(abs);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
      } catch {
        continue;
      }
      if (isDirectory) {
        visit(abs, depth + 1);
        continue;
      }
      if (!isFile || !name.endsWith(".gguf")) continue;
      const lowerPath = abs.toLowerCase();
      const lowerName = name.toLowerCase();
      // Embedding match runs first so a dedicated embedding GGUF is assigned
      // before the broader Eliza-1 chat rule below.
      if (!embedding && lowerPath.includes("embedding")) {
        embedding = abs;
      } else if (
        !chat &&
        lowerName.includes("eliza-1") &&
        !lowerPath.includes("/mtp/") &&
        !lowerPath.includes("/tts/") &&
        !lowerPath.includes("/asr/") &&
        !lowerPath.includes("/vad/") &&
        !lowerName.includes("drafter") &&
        !lowerName.includes("mmproj")
      ) {
        chat = abs;
      }
    }
  };
  visit(modelsDir, 0);
  return { chat, embedding };
}

/**
 * Resolve chat / embedding GGUF paths from on-disk state, in priority order:
 * device assignments (`assignments.json` + `registry.json`, written by the UI
 * download flow) → bundled `manifest.json` (build-time staging) → glob
 * fallback. Pure fs reads; safe to re-run on a long-lived process.
 */
function resolveBundledModelPaths(modelsDir: string): {
  chat: string | null;
  embedding: string | null;
} {
  const assigned = readAssignedBundledModels(modelsDir);
  const manifest = readBundledModelManifest(modelsDir);
  let resolved = {
    chat: assigned.chat ?? manifest.chat,
    embedding: assigned.embedding ?? manifest.embedding,
  };
  if (!resolved.chat || !resolved.embedding) {
    const fallback = fallbackFindBundledModels(modelsDir);
    resolved = {
      chat: resolved.chat ?? fallback.chat,
      embedding: resolved.embedding ?? fallback.embedding,
    };
  }
  return resolved;
}

/**
 * Per-modelType auto-load gate. We track which model role is currently
 * loaded so a chat handler doesn't try to swap-in the embedding model
 * (and vice versa) on every call. Promise-shaped so two concurrent
 * requests share the single load.
 */
type LoadedRole = "chat" | "embedding" | null;
function makeLoaderLifecycle(loader: AospLoader): {
  ensureChatLoaded(): Promise<void>;
  ensureEmbeddingLoaded(): Promise<void>;
  markEvicted(): void;
} {
  let currentRole: LoadedRole = null;
  let inflight: Promise<void> | null = null;
  const modelsDir = resolveBundledModelsDir();
  let resolved = resolveBundledModelPaths(modelsDir);
  async function loadRole(role: "chat" | "embedding"): Promise<void> {
    if (currentRole === role) return;
    if (inflight) return inflight;
    let target = role === "chat" ? resolved.chat : resolved.embedding;
    if (!target) {
      // The models dir is empty at first boot, so the lifecycle's initial
      // resolve returns null. A device/UI download (the recommendation engine
      // picks a device-appropriate tier) lands the GGUF + assignments.json +
      // registry.json AFTER boot. Re-scan here before deciding to auto-download
      // or fail — otherwise a long-lived agent never sees a model installed
      // post-boot, and on a build with ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1
      // (UI owns downloads) chat fails permanently with "No bundled model".
      const rescan = resolveBundledModelPaths(modelsDir);
      resolved = {
        chat: resolved.chat ?? rescan.chat,
        embedding: resolved.embedding ?? rescan.embedding,
      };
      target = role === "chat" ? resolved.chat : resolved.embedding;
    }
    if (!target) {
      if (process.env.ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD?.trim() === "1") {
        throw new Error(
          `[aosp-local-inference] No bundled ${role} model found under ${modelsDir} and auto-download is disabled (ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1).`,
        );
      }
      target = await downloadRecommendedAospModel(role, modelsDir);
      if (role === "chat") {
        resolved.chat = target;
      } else {
        resolved.embedding = target;
      }
    }
    inflight = (async () => {
      writeAospLlamaDebugLog("bootstrap:loadRole:start", {
        role,
        model: path.basename(target),
      });
      logger.info(
        `[aosp-local-inference] Loading bundled ${role} model: ${path.basename(target)}`,
      );
      try {
        await loader.loadModel(buildAospLoadModelArgs(role, target));
        currentRole = role;
        writeAospActiveModelState({
          status: "ready",
          role,
          provider: PROVIDER,
          path: target,
          loadedAt: new Date().toISOString(),
        });
      } catch (err) {
        writeAospActiveModelState({
          status: "error",
          role,
          provider: PROVIDER,
          path: target,
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        });
        throw err;
      }
      writeAospLlamaDebugLog("bootstrap:loadRole:done", {
        role,
        model: path.basename(target),
      });
      logger.info(
        `[aosp-local-inference] Loaded ${role} model (path=${target})`,
      );
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }
  return {
    ensureChatLoaded: () => loadRole("chat"),
    ensureEmbeddingLoaded: () => loadRole("embedding"),
    // Out-of-band eviction (voice handlers free the chat model directly via
    // loader.unloadModel() to reclaim RAM for the cold ASR/TTS load). That
    // bypasses loadRole, so `currentRole` would stay stale ("chat") and the
    // next ensureChatLoaded() would short-circuit and run generate() against a
    // null ctx. Resetting `currentRole` here forces the next ensure*Loaded()
    // to actually reload. Safe to call when no load is in flight; if a load is
    // mid-flight the clear just means the subsequent ensure reloads, which is
    // the intended post-eviction behaviour anyway.
    markEvicted: () => {
      currentRole = null;
    },
  };
}

/**
 * Route one text generation through the process-wide interactive-over-
 * background lane (elizaOS/eliza#11914). The fused context runs one decode at
 * a time, so ALL text generates (model load included — a swap touches the same
 * native lane) acquire the shared {@link getInferencePriorityGate} first:
 * interactive turns dispatch ahead of queued background jobs; background jobs
 * run only when the lane is idle, wait at most the RAM-class bound before
 * failing back to their scheduler, and are clamped to the RAM-class budget
 * (`maxTokens` + prompt size) so one autonomous job cannot hold the lane for
 * multi-minute stretches on a constrained phone.
 *
 * Exported for unit tests; production callers go through the registered
 * TEXT_SMALL / TEXT_LARGE handlers.
 */
export async function generateOnPriorityLane(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
  params: GenerateTextParams,
): Promise<string> {
  const priority = params.priority ?? "interactive";
  const args = buildGenerateArgsFromParams(params);
  let lockWaitMs: number | undefined;
  if (priority === "background") {
    const budget = resolveBackgroundInferenceBudget(
      classifyInferenceRamClass(),
    );
    const clampedArgs = applyBackgroundInferenceBudget(
      { prompt: args.prompt, maxTokens: args.maxTokens },
      budget,
    );
    if (clampedArgs.clamped.length > 0) {
      logger.info(
        `[aosp-local-inference] background generate clamped to the device-class budget: ${clampedArgs.clamped.join(", ")} (#11914)`,
      );
    }
    args.prompt = clampedArgs.prompt;
    args.maxTokens = clampedArgs.maxTokens;
    lockWaitMs = budget.lockWaitMs;
  }
  return getInferencePriorityGate().runExclusive(
    {
      priority,
      label: `aosp-text (${args.prompt.length} chars, maxTokens=${args.maxTokens ?? "default"})`,
      ...(lockWaitMs !== undefined ? { waitMs: lockWaitMs } : {}),
      ...(params.signal ? { signal: params.signal } : {}),
    },
    async () => {
      writeAospLlamaDebugLog("bootstrap:generate:ensureChat:start", {
        maxTokens: args.maxTokens ?? null,
        priority,
        hasGrammar:
          typeof args.grammar === "string" && args.grammar.trim().length > 0,
      });
      await lifecycle.ensureChatLoaded();
      writeAospLlamaDebugLog("bootstrap:generate:ensureChat:done");
      writeAospLlamaDebugLog("bootstrap:generate:start", {
        promptChars: args.prompt.length,
        maxTokens: args.maxTokens ?? null,
        priority,
        grammarBytes: args.grammar?.trim().length ?? 0,
      });
      return loader.generate(args);
    },
  );
}

/**
 * Internal: attempt local generate and classify the outcome explicitly.
 * The wrapper at priority -1 consumes this and decides whether to forward
 * to a cloud handler. Load errors and generate errors classify through the
 * same {@link classifyLocalError} table.
 */
async function tryLocalGenerate(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
  params: GenerateTextParams,
): Promise<LocalGenerateOutcome> {
  try {
    const text = await generateOnPriorityLane(loader, lifecycle, params);
    return { kind: "ok", text };
  } catch (err) {
    const cls = classifyLocalError(err);
    if (!cls.fallback) {
      throw err;
    }
    return {
      kind: "fallback",
      reason: cls.reason,
      cause: err instanceof Error ? err : undefined,
    };
  }
}

function makeGenerateHandler(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
): GenerateTextHandler {
  // The runtime injects `signal` into `params` from the active streaming
  // context's `abortSignal` when the caller didn't pass one explicitly
  // (see runtime.ts useModel: paramsAsStreaming.signal ??= abortSignal).
  // `generateOnPriorityLane` forwards it into the FFI decode loop so
  // APP_PAUSE etc. can cancel an in-flight phone-CPU prefill that would
  // otherwise pin the bun process for minutes.
  return async (_runtime, params) =>
    generateOnPriorityLane(loader, lifecycle, params);
}

/**
 * Build a TEXT_* handler that tries local first, then forwards to the
 * highest-priority cloud handler when local reports a fallback-eligible
 * condition. Registered at `CLOUD_FALLBACK_PRIORITY = -1` so the runtime's
 * default lookup still picks the local handler (priority 0) — this wrapper
 * is the SAFETY NET for callers that explicitly target the wrapper or for
 * builds where local isn't registered.
 *
 * Exported for unit tests; production callers go through
 * `ensureAospLocalInferenceHandlers`.
 */
function makeCloudFallbackHandler(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
  modelType: (typeof ModelType)[keyof typeof ModelType],
): GenerateTextHandler {
  return async (runtime, params) => {
    const outcome = await tryLocalGenerate(loader, lifecycle, params);
    if (outcome.kind === "ok") {
      return outcome.text;
    }
    const candidate = findCloudCandidate(runtime, modelType, PROVIDER);
    logger.info(
      {
        src: "aosp-local-inference",
        event: "cloud-fallback-engaged",
        modelType: String(modelType),
        reason: outcome.reason,
        candidateProvider: candidate?.provider ?? null,
        cause: outcome.cause?.message,
      },
      "[aosp-local-inference] cloud-fallback engaged",
    );
    if (!candidate) {
      // No cloud handler available — surface a typed error so callers see
      // the real reason instead of a generic "no handler" message.
      const err = new Error(
        `[aosp-local-inference] Local inference unavailable (${outcome.reason}) and no cloud handler is registered for ${String(modelType)}. Pair Eliza Cloud or install a provider plugin to enable fallback.`,
      );
      if (outcome.cause) {
        (err as Error & { cause?: unknown }).cause = outcome.cause;
      }
      throw err;
    }
    return candidate.handler(runtime, params);
  };
}

/**
 * Normalize the runtime's TEXT_EMBEDDING input shape — `params` may be the
 * structured `TextEmbeddingParams` (when called from a typed plugin), a
 * raw string (when called from action runners), or `null` (an internal
 * warmup probe used to size the shipped embedding vector).
 *
 * Mirrors `ensure-local-inference-handler.ts:extractEmbeddingText`.
 */
function extractEmbeddingText(
  params: TextEmbeddingParams | string | null,
): string {
  if (params === null) return "";
  if (typeof params === "string") return params;
  return params.text;
}

function makeEmbeddingHandler(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
): EmbeddingHandler {
  let loggedDisabled = false;
  return async (_runtime, params) => {
    if (!isAospLocalEmbeddingEnabled()) {
      if (!loggedDisabled) {
        loggedDisabled = true;
        logger.info(
          "[aosp-local-inference] Local embeddings disabled; serving zero-vector TEXT_EMBEDDING results (set ELIZA_LOCAL_EMBEDDING_ENABLED=1 to load the embedding GGUF)",
        );
      }
      return disabledAospEmbeddingVector();
    }
    await lifecycle.ensureEmbeddingLoaded();
    const text = extractEmbeddingText(params);
    const result = await loader.embed({ input: text });
    return result.embedding;
  };
}

export function extractSpeechText(params: TextToSpeechParams | string): string {
  if (typeof params === "string") return params;
  if (params && typeof params === "object" && typeof params.text === "string") {
    return params.text;
  }
  throw new Error(
    "[aosp-local-inference] TEXT_TO_SPEECH requires a string or { text } input",
  );
}

export function extractSpeechSignal(
  params: TextToSpeechParams | string,
): AbortSignal | undefined {
  return typeof params === "object" && params !== null
    ? params.signal
    : undefined;
}

function encodeWavPcm16(pcm: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2;
  const dataBytes = pcm.length * bytesPerSample;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    view.setInt16(
      44 + i * bytesPerSample,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return out;
}

/**
 * Pre-warm the fused Kokoro TTS pipeline on a delayed timer so the
 * first user-facing synthesis does not pay the GGUF load + voice-preset
 * init cost inside a request handler. Best-effort: failures are
 * logged at WARN since the foreground request will surface a clean
 * error if the FFI surface is unavailable.
 */
export function prewarmAospKokoroTextToSpeechHandler(
  handler: TextToSpeechHandler,
  opts: AospKokoroPrewarmOptions = {},
): void {
  if (readBooleanEnv("ELIZA_AOSP_TTS_PREWARM") !== true) return;

  const delayMs = readPositiveIntEnv("ELIZA_AOSP_TTS_PREWARM_DELAY_MS", 5_000);
  const timeoutMs = readPositiveIntEnv(
    "ELIZA_AOSP_TTS_PREWARM_TIMEOUT_MS",
    45_000,
  );
  const text =
    process.env.ELIZA_AOSP_TTS_PREWARM_TEXT?.trim() || "Hello from Eliza.";

  setTimeout(() => {
    if (opts.shouldSkip?.()) {
      logger.info(
        "[aosp-local-inference] Kokoro TEXT_TO_SPEECH pre-warm skipped; foreground TTS already warmed the backend",
      );
      return;
    }
    const started = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    void handler({} as never, {
      text,
      signal: abortController.signal,
    })
      .then((bytes) => {
        logger.info(
          `[aosp-local-inference] Kokoro TEXT_TO_SPEECH pre-warm completed in ${Date.now() - started}ms (${bytes.byteLength} bytes)`,
        );
      })
      .catch((err) => {
        logger.warn(
          "[aosp-local-inference] Kokoro TEXT_TO_SPEECH pre-warm failed: " +
            (err instanceof Error ? err.message : String(err)),
        );
      })
      .finally(() => {
        clearTimeout(timeout);
      });
  }, delayMs);
}

function resolveAssignedChatBundleRoot(): string {
  const modelsDir = resolveBundledModelsDir();
  const assigned = readAssignedBundledModels(modelsDir);
  const manifest = readBundledModelManifest(modelsDir);
  const fallback = fallbackFindBundledModels(modelsDir);
  const chatModel = assigned.chat ?? manifest.chat ?? fallback.chat;
  if (!chatModel) {
    throw new Error(
      `[aosp-local-inference] voice requires an installed Eliza-1 chat bundle under ${modelsDir}`,
    );
  }
  return resolveBundleRootFromModelPath(chatModel);
}

function isFfiNullPointer(value: unknown): boolean {
  return value === null || value === undefined || value === 0 || value === 0n;
}

/**
 * Assert a bun:ffi `dlopen(...).symbols` table as the fused-LLM FFI surface.
 * bun's inferred symbol-table type does not structurally line up with the
 * hand-written {@link AospFusedLlmSymbols} interface (different function
 * representations), so the assertion is centralized here — one auditable FFI
 * boundary instead of the same `as unknown as` double-cast repeated inline at
 * every `createAospStreamingLlmBinding` call site (#12452 type-safety ratchet).
 */
function asFusedLlmSymbols(symbols: unknown): AospFusedLlmSymbols {
  return symbols as AospFusedLlmSymbols;
}

// Free RAM (MiB) at or above which the resident chat model is KEPT across a cold
// voice-model load instead of being evicted. Eviction frees room for the ~1.4 GB
// ASR / ~0.66 GB TTS load so it cannot trip lmkd, but it forces a synchronous
// chat-model reload before the next reply that stalls the single-threaded
// agent's HTTP listener (a concurrent createConversation then sees a spurious
// local_agent_unavailable). When there is enough headroom to hold both models
// the eviction is pure cost, so gate it on actual memory pressure.
export const VOICE_COLOAD_KEEP_AVAIL_MB = 2200;

/**
 * Parse `MemAvailable` (in MiB) from `/proc/meminfo` text. Returns `null` when
 * the field is absent (e.g. a non-Linux / unexpected layout). Exported for unit
 * testing the pure parse without touching the filesystem.
 */
export function parseMemAvailableMb(meminfo: string): number | null {
  const match = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/);
  return match ? Number(match[1]) / 1024 : null;
}

/**
 * Decide whether to evict the resident chat model before a cold voice-model
 * load, given free RAM in MiB (`null` = unknown). Unknown memory falls back to
 * eviction, preserving the original always-evict safety on platforms where
 * `/proc/meminfo` is unavailable. Pure; exported for unit testing.
 */
export function shouldEvictChatForAvailMb(availMb: number | null): boolean {
  if (availMb === null) return true;
  return availMb < VOICE_COLOAD_KEEP_AVAIL_MB;
}

function shouldEvictChatForVoiceLoad(): boolean {
  try {
    return shouldEvictChatForAvailMb(
      parseMemAvailableMb(readFileSync("/proc/meminfo", "utf8")),
    );
  } catch {
    return true;
  }
}

export function makeAospFusedKokoroTextToSpeechHandler(): TextToSpeechHandler {
  let contextPromise: Promise<{
    ffi: BunFfiModule;
    symbols: Record<string, (...args: unknown[]) => unknown>;
    close: () => void;
    ctx: unknown;
    config: AospFusedKokoroConfig;
    sampleRate: number;
  }> | null = null;

  async function ensureContext(): Promise<{
    ffi: BunFfiModule;
    symbols: Record<string, (...args: unknown[]) => unknown>;
    close: () => void;
    ctx: unknown;
    config: AospFusedKokoroConfig;
    sampleRate: number;
  }> {
    if (contextPromise) return contextPromise;
    contextPromise = Promise.resolve()
      .then(async () => {
        const config = resolveAospFusedKokoroConfig();
        if (!config) {
          throw new Error(
            "[aosp-local-inference] fused Kokoro TEXT_TO_SPEECH is not available: expected libelizainference.so plus an active Eliza-1 bundle with a staged tts/kokoro/ voice.",
          );
        }
        const ffi = await loadAospVoiceFfi();
        const T = ffi.FFIType;
        const usize = T.usize ?? T.ptr;
        const lib = ffi.dlopen(config.libPath, {
          eliza_inference_create: { args: [T.ptr, T.ptr], returns: T.ptr },
          eliza_inference_destroy: { args: [T.ptr], returns: T.void },
          eliza_inference_kokoro_supported: { args: [], returns: T.i32 },
          eliza_inference_kokoro_load: {
            // ctx, gguf_path, voice_bin_path, style_dim, out_error
            args: [T.ptr, T.ptr, T.ptr, T.i32, T.ptr],
            returns: T.i32,
          },
          eliza_inference_kokoro_synthesize: {
            // ctx, text, text_len, speed, out_pcm, max_samples, out_error
            args: [T.ptr, T.ptr, usize, T.f32, T.ptr, usize, T.ptr],
            returns: T.i32,
          },
          eliza_inference_kokoro_sample_rate: {
            args: [T.ptr],
            returns: T.i32,
          },
          eliza_inference_free_string: { args: [usize], returns: T.void },
        });
        const symbols = lib.symbols;
        const errCreate = Buffer.alloc(8);
        const bundleArg = cString(config.bundleRoot);
        const ctx = symbols.eliza_inference_create(
          ffi.ptr(bundleArg),
          ffi.ptr(errCreate),
        );
        if (isFfiNullPointer(ctx)) {
          const message = readFfiStringAndFree(ffi, symbols, errCreate);
          try {
            lib.close();
          } catch {}
          throw new Error(
            `[aosp-local-inference] fused Kokoro create failed: ${message}`,
          );
        }

        if ((symbols.eliza_inference_kokoro_supported?.() as number) !== 1) {
          try {
            symbols.eliza_inference_destroy(ctx);
          } catch {}
          try {
            lib.close();
          } catch {}
          throw new Error(
            "[aosp-local-inference] libelizainference.so does not export the Kokoro TTS engine (pre-v10 build); rebuild the fused lib with -DLLAMA_BUILD_KOKORO=ON.",
          );
        }

        const errLoad = Buffer.alloc(8);
        const loadStarted = Date.now();
        const ggufArg = cString(config.kokoroGgufPath);
        const voiceArg = cString(config.kokoroVoicePath);
        const loadRc = symbols.eliza_inference_kokoro_load(
          ctx,
          ffi.ptr(ggufArg),
          ffi.ptr(voiceArg),
          KOKORO_STYLE_DIM,
          ffi.ptr(errLoad),
        ) as number;
        if (loadRc < 0) {
          const message = readFfiStringAndFree(ffi, symbols, errLoad);
          try {
            symbols.eliza_inference_destroy(ctx);
          } catch {}
          try {
            lib.close();
          } catch {}
          throw new Error(
            `[aosp-local-inference] fused Kokoro load rc=${loadRc}: ${message}`,
          );
        }

        const sampleRate =
          (symbols.eliza_inference_kokoro_sample_rate?.(ctx) as number) ||
          24_000;
        logger.info(
          `[aosp-local-inference] fused Kokoro TEXT_TO_SPEECH backend ready in ${Date.now() - loadStarted}ms (lib=${config.libPath}, bundle=${path.basename(config.bundleRoot)}, sampleRate=${sampleRate})`,
        );
        return {
          ffi,
          symbols,
          close: lib.close,
          ctx,
          config,
          sampleRate,
        };
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
    return contextPromise;
  }

  return async (_runtime, params) => {
    const text = extractSpeechText(params).trim();
    if (!text) {
      throw new Error(
        "[aosp-local-inference] TEXT_TO_SPEECH requires non-empty text",
      );
    }
    const signal = extractSpeechSignal(params);
    if (signal?.aborted) {
      throw new Error("[aosp-local-inference] TEXT_TO_SPEECH aborted");
    }

    // Kokoro-82M is a ~50 MB acoustic model in a SEPARATE FFI allocation from
    // the resident chat model, so — unlike the retired ~0.66 GB neural TTS
    // model — it loads alongside chat without tripping lmkd's low watermark.
    // No chat eviction is needed.
    const started = Date.now();
    const { ffi, symbols, ctx, config, sampleRate } = await ensureContext();
    const readyMs = Date.now() - started;
    const maxSeconds = readPositiveIntEnv("ELIZA_AOSP_TTS_MAX_SECONDS", 30);
    const maxSamples = Math.max(sampleRate, maxSeconds * sampleRate);
    const out = Buffer.alloc(maxSamples * 4);
    const errTts = Buffer.alloc(8);
    const textArg = cString(text);
    const textBytes = Buffer.byteLength(text, "utf8");
    const synthStarted = Date.now();
    const rc = symbols.eliza_inference_kokoro_synthesize(
      ctx,
      ffi.ptr(textArg),
      BigInt(textBytes),
      1.0,
      ffi.ptr(out),
      BigInt(maxSamples),
      ffi.ptr(errTts),
    ) as number;
    const synthMs = Date.now() - synthStarted;
    if (rc < 0) {
      throw new Error(
        `[aosp-local-inference] fused Kokoro TEXT_TO_SPEECH rc=${rc}: ${readFfiStringAndFree(ffi, symbols, errTts)}`,
      );
    }
    if (signal?.aborted) {
      throw new Error("[aosp-local-inference] TEXT_TO_SPEECH aborted");
    }
    const pcmBytes = out.subarray(0, rc * 4);
    const pcm = new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, rc);
    const encodeStarted = Date.now();
    const wav = encodeWavPcm16(pcm, sampleRate);
    const encodeMs = Date.now() - encodeStarted;
    logger.info(
      `[aosp-local-inference] fused Kokoro TEXT_TO_SPEECH completed chars=${text.length} bundle=${path.basename(config.bundleRoot)} backendReadyMs=${readyMs} synthMs=${synthMs} encodeMs=${encodeMs} pcmSamples=${rc} wavBytes=${wav.byteLength} sampleRate=${sampleRate}`,
    );
    return wav;
  };
}

export function makeAospTextToSpeechHandler(
  opts: { kokoro?: TextToSpeechHandler; onForegroundUse?: () => void } = {},
): TextToSpeechHandler {
  const kokoro = opts.kokoro ?? makeAospFusedKokoroTextToSpeechHandler();
  return async (runtime, params) => {
    opts.onForegroundUse?.();
    return kokoro(runtime, params);
  };
}

type BunFfiModule = {
  dlopen: (
    file: string,
    symbols: Record<string, { args: readonly number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
    close: () => void;
  };
  FFIType: Record<string, number>;
  ptr: (value: ArrayBufferView) => bigint | number;
  read?: { ptr?: (value: ArrayBufferView, offset?: number) => bigint | number };
  /** Wrap a raw native pointer as an ArrayBuffer view (used to read the
   *  malloc'd `int*` token buffer out of `eliza_inference_tokenize`). */
  toArrayBuffer?: (
    ptr: bigint | number,
    byteOffset?: number,
    byteLength?: number,
  ) => ArrayBuffer;
  CString?: new (ptr: bigint | number) => { toString(): string };
  JSCallback?: new (
    fn: (...args: never[]) => unknown,
    def: { args: readonly number[]; returns: number },
  ) => { readonly ptr: bigint | number; close: () => void };
};

async function loadAospVoiceFfi(): Promise<BunFfiModule> {
  const ffiSpecifier = "bun" + ":ffi";
  const ffi = (await import(ffiSpecifier)) as BunFfiModule;
  if (
    typeof ffi.dlopen !== "function" ||
    typeof ffi.ptr !== "function" ||
    !ffi.FFIType
  ) {
    throw new Error("[aosp-local-inference] bun:ffi is unavailable");
  }
  return ffi;
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`, "utf8");
}

function resolveElizaInferenceLibPath(): string {
  return resolveAospElizaInferenceLibPath();
}

function resolveAospFusedKokoroConfig(): AospFusedKokoroConfig | null {
  const libPath = resolveElizaInferenceLibPath();
  if (!existsSync(libPath)) return null;
  let bundleRoot: string;
  try {
    bundleRoot = resolveAssignedChatBundleRoot();
  } catch {
    return null;
  }
  // Ensure the on-device Kokoro voice is present (Kokoro is the only on-device
  // TTS backend). Without tts/kokoro/, on-device TTS has nothing to synthesize
  // and the app falls back to the platform "android voice". This fetches in the
  // background; the platform TTS covers replies until it lands.
  ensureKokoroTtsAssetsInBackground(bundleRoot, resolveAssignedChatTierSlug());
  const kokoroDir = path.join(bundleRoot, "tts", "kokoro");
  const kokoroGgufPath = path.join(kokoroDir, KOKORO_GGUF_FILE);
  const kokoroVoicePath = path.join(kokoroDir, KOKORO_VOICE_FILE);
  if (!existsSync(kokoroGgufPath) || !existsSync(kokoroVoicePath)) {
    // Kokoro voice not staged yet — the background download above will land it;
    // until then on-device TTS reports unavailable and the platform TTS covers.
    return null;
  }
  return { libPath, bundleRoot, kokoroGgufPath, kokoroVoicePath };
}

/**
 * The fused lib resolves the chat GGUF strictly as `<bundleRoot>/text/*.gguf`,
 * but Android first-run staging lays the curated model FLAT under `models/`.
 * Mirror the bionic host's hardlink-bundle shim (`deriveBundleDir` in
 * plugin-local-inference's bionic-host-loader) so the fused musl loader
 * accepts the flat layout: hardlink (or symlink) the flat GGUF into
 * `<bundleRoot>/text/` without copying the multi-GB model bytes. Best-effort —
 * on failure the fused create/tokenize surfaces its own loud
 * "no text GGUF found" diagnostic (verified live on emulator-5554).
 */
function ensureFusedTextBundleLayout(
  modelPath: string,
  bundleRoot: string,
): void {
  try {
    if (!modelPath.endsWith(".gguf") || !existsSync(modelPath)) return;
    if (path.basename(path.dirname(modelPath)) === "text") return;
    const textDir = path.join(bundleRoot, "text");
    const target = path.join(textDir, path.basename(modelPath));
    if (existsSync(target)) return;
    mkdirSync(textDir, { recursive: true });
    try {
      linkSync(modelPath, target);
    } catch {
      symlinkSync(modelPath, target);
    }
    writeAospLlamaDebugLog("bootstrap:fusedText:flatBundleShim", {
      modelPath,
      target,
    });
  } catch (err) {
    writeAospLlamaDebugLog("bootstrap:fusedText:flatBundleShimFailed", {
      modelPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function resolveBundleRootFromModelPath(modelPath: string): string {
  const parts = modelPath.replaceAll("\\", "/").split("/");
  const bundleIndex = parts.findIndex((part) => part.endsWith(".bundle"));
  if (bundleIndex >= 0) {
    return path.join("/", ...parts.slice(0, bundleIndex + 1));
  }
  const textIndex = parts.lastIndexOf("text");
  if (textIndex > 0) {
    return path.join("/", ...parts.slice(0, textIndex));
  }
  return path.dirname(modelPath);
}

function resolveAssignedVoiceBundleRoot(): string {
  const bundleRoot = resolveAssignedChatBundleRoot();
  if (!existsSync(path.join(bundleRoot, "asr"))) {
    throw new Error(
      `[aosp-local-inference] TRANSCRIPTION requires ASR assets under ${bundleRoot}/asr`,
    );
  }
  return bundleRoot;
}

/**
 * Non-throwing check for whether the assigned chat bundle carries the ASR
 * assets the local TRANSCRIPTION handler needs. Used to gate handler
 * REGISTRATION: the model registry is what readiness probes read, so a
 * registered handler that throws on the first invocation reports the model as
 * available when it is not. On AOSP the native SpeechRecognizer/SODA path owns
 * on-device STT, so a missing whisper bundle is the normal case — not an error
 * — and the honest signal is simply "no local TRANSCRIPTION handler".
 */
export function aospAsrAssetsPresent(): boolean {
  try {
    return existsSync(path.join(resolveAssignedChatBundleRoot(), "asr"));
  } catch {
    return false;
  }
}

function readFfiStringAndFree(
  ffi: BunFfiModule,
  symbols: Record<string, (...args: unknown[]) => unknown>,
  ptrBuffer: Buffer,
): string {
  const raw = readFfiPointer(ffi, ptrBuffer, 0);
  if (!raw || raw === 0n) return "(no diagnostic)";
  let text = "(unreadable diagnostic)";
  try {
    text = ffi.CString
      ? new ffi.CString(Number(raw)).toString()
      : "(no CString)";
  } catch {}
  try {
    symbols.eliza_inference_free_string?.(raw);
  } catch {}
  return text;
}

function readFfiPointer(
  _ffi: BunFfiModule,
  ptrBuffer: Buffer,
  offset = 0,
): bigint {
  // NOTE: never hand the Buffer to `ffi.read.ptr` — bun's `read.ptr` takes a
  // raw Pointer NUMBER and throws "Expected a pointer" for a Buffer (verified
  // on-device, bun 1.3.14). That throw masked every native error diagnostic
  // on the fused-lib error paths. The out-param bytes live in JS memory, so a
  // DataView read is always correct.
  const view = new DataView(
    ptrBuffer.buffer,
    ptrBuffer.byteOffset,
    ptrBuffer.byteLength,
  );
  return view.getBigUint64(offset, true);
}

function decodeMonoPcm16WavBytes(bytes: Uint8Array): {
  samples: Float32Array;
  sampleRate: number;
} {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(
      "[aosp-local-inference] TRANSCRIPTION expected PCM WAV bytes",
    );
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataOffset = body;
      dataLength = Math.min(size, buffer.length - body);
    }
    offset = body + size + (size % 2);
  }

  if (channels <= 0 || sampleRate <= 0 || dataOffset < 0) {
    throw new Error(
      "[aosp-local-inference] TRANSCRIPTION WAV missing fmt/data",
    );
  }
  if (bitsPerSample !== 16) {
    throw new Error(
      `[aosp-local-inference] TRANSCRIPTION expected PCM16 WAV, got ${bitsPerSample} bits`,
    );
  }

  const frames = Math.floor(dataLength / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      sum += buffer.readInt16LE(dataOffset + (i * channels + channel) * 2);
    }
    samples[i] = sum / channels / 32768;
  }
  return { samples, sampleRate };
}

function resampleLinear(
  samples: Float32Array,
  fromHz: number,
  toHz: number,
): Float32Array {
  if (fromHz === toHz) return samples;
  const ratio = toHz / fromHz;
  const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = (samples[i0] ?? 0) * (1 - f) + (samples[i1] ?? 0) * f;
  }
  return out;
}

function bytesFromTranscriptionInput(
  value: Uint8Array | ArrayBuffer | Buffer,
): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function extractAospTranscriptionAudio(
  params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
): { samples: Float32Array; sampleRate: number; signal?: AbortSignal } {
  if (typeof params === "string") {
    throw new Error(
      "[aosp-local-inference] TRANSCRIPTION via local ASR requires WAV bytes or { pcm, sampleRateHz }; URL/path strings are not fetched",
    );
  }
  if (params instanceof Uint8Array || params instanceof ArrayBuffer) {
    return decodeMonoPcm16WavBytes(bytesFromTranscriptionInput(params));
  }
  if (!params || typeof params !== "object") {
    throw new Error(
      "[aosp-local-inference] TRANSCRIPTION requires WAV bytes or { pcm, sampleRateHz }",
    );
  }
  if ("pcm" in params && params.pcm instanceof Float32Array) {
    const sampleRate =
      ("sampleRateHz" in params ? params.sampleRateHz : undefined) ??
      ("sampleRate" in params ? params.sampleRate : undefined);
    if (typeof sampleRate !== "number" || sampleRate <= 0) {
      throw new Error(
        "[aosp-local-inference] TRANSCRIPTION { pcm } requires a positive sampleRateHz",
      );
    }
    return { samples: params.pcm, sampleRate, signal: params.signal };
  }
  if (
    "audio" in params &&
    (params.audio instanceof Uint8Array || params.audio instanceof ArrayBuffer)
  ) {
    return {
      ...decodeMonoPcm16WavBytes(bytesFromTranscriptionInput(params.audio)),
      signal: params.signal,
    };
  }
  throw new Error(
    "[aosp-local-inference] TRANSCRIPTION requires PCM16 WAV bytes or { pcm, sampleRateHz }",
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

async function transcribeWithAospElizaInference(
  audio: { samples: Float32Array; sampleRate: number },
  signal?: AbortSignal,
  loader?: AospLoader,
  onEvicted?: () => void,
): Promise<string> {
  assertNotAborted(signal);
  const libPath = resolveElizaInferenceLibPath();
  if (!existsSync(libPath)) {
    throw new Error(
      `[aosp-local-inference] libelizainference.so missing at ${libPath}`,
    );
  }
  // Release the resident chat model before the cold ASR load. The fused ASR
  // context (eliza_inference_create + mmap_acquire("asr")) maps the ~1.4 GB
  // Eliza-1 ASR model + projector; loading it while the ~0.55 GB chat model
  // and its hot KV/compute buffers are still resident spikes RAM past lmkd's
  // low watermark and the detached agent — which an unprivileged app cannot
  // oom-protect — gets killed mid-load. The chat model auto-reloads on the
  // next TEXT turn (makeGenerateHandler -> lifecycle.ensureChatLoaded), so the
  // eviction is safe; mirrors the cold-TTS eviction in the fused TTS handler.
  if (
    loader &&
    shouldEvictChatForVoiceLoad() &&
    typeof loader.currentModelPath === "function" &&
    loader.currentModelPath() !== null &&
    typeof loader.unloadModel === "function"
  ) {
    try {
      await loader.unloadModel();
      // Tell the lifecycle the chat model is gone so the next text turn
      // actually reloads it (loadRole short-circuits on a stale currentRole
      // otherwise). Done after the unload succeeds so we never mark evicted
      // when the model is in fact still resident.
      onEvicted?.();
      logger.info(
        "[aosp-local-inference] released chat model before fused ASR load to free memory",
      );
    } catch {
      // Best-effort: a failed eviction just means ASR loads under the prior
      // (possibly tight) memory conditions — no worse than before.
    }
  }
  const bundleRoot = resolveAssignedVoiceBundleRoot();
  const ffi = await loadAospVoiceFfi();
  const T = ffi.FFIType;
  const usize = T.usize ?? T.ptr;
  const lib = ffi.dlopen(libPath, {
    eliza_inference_create: { args: [T.cstring, T.ptr], returns: T.ptr },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: {
      args: [T.ptr, T.cstring, T.ptr],
      returns: T.i32,
    },
    eliza_inference_asr_transcribe: {
      args: [T.ptr, T.ptr, usize, T.i32, T.ptr, usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_free_string: { args: [usize], returns: T.void },
  });
  const symbols = lib.symbols;
  const errCreate = Buffer.alloc(8);
  const ctx = symbols.eliza_inference_create(
    cString(bundleRoot),
    ffi.ptr(errCreate),
  ) as bigint;
  if (!ctx || ctx === 0n) {
    const message = readFfiStringAndFree(ffi, symbols, errCreate);
    try {
      lib.close();
    } catch {}
    throw new Error(`[aosp-local-inference] ASR create failed: ${message}`);
  }
  try {
    const errAcquire = Buffer.alloc(8);
    const acquireRc = symbols.eliza_inference_mmap_acquire(
      ctx,
      cString("asr"),
      ffi.ptr(errAcquire),
    ) as number;
    if (acquireRc < 0) {
      throw new Error(
        `[aosp-local-inference] ASR mmap_acquire rc=${acquireRc}: ${readFfiStringAndFree(ffi, symbols, errAcquire)}`,
      );
    }
    assertNotAborted(signal);
    const pcm16k = resampleLinear(audio.samples, audio.sampleRate, 16000);
    const pcmBytes = Buffer.from(
      pcm16k.buffer,
      pcm16k.byteOffset,
      pcm16k.byteLength,
    );
    const out = Buffer.alloc(4096);
    const errAsr = Buffer.alloc(8);
    const rc = symbols.eliza_inference_asr_transcribe(
      ctx,
      ffi.ptr(pcmBytes),
      BigInt(pcm16k.length),
      16000,
      ffi.ptr(out),
      BigInt(out.length),
      ffi.ptr(errAsr),
    ) as number;
    if (rc < 0) {
      throw new Error(
        `[aosp-local-inference] ASR transcribe rc=${rc}: ${readFfiStringAndFree(ffi, symbols, errAsr)}`,
      );
    }
    assertNotAborted(signal);
    return out.toString("utf8", 0, rc).trim();
  } finally {
    try {
      symbols.eliza_inference_destroy(ctx);
    } catch {}
    try {
      lib.close();
    } catch {}
  }
}

export function makeAospTranscriptionHandler(
  loader?: AospLoader,
  onEvicted?: () => void,
): TranscriptionHandler {
  return async (_runtime, params) => {
    const { signal, ...audio } = extractAospTranscriptionAudio(params);
    return transcribeWithAospElizaInference(audio, signal, loader, onEvicted);
  };
}

/* -------------------------------------------------------------------- */
/* Fused libelizainference text loader (bun:ffi, no JNI).                */
/*                                                                       */
/* On AOSP + the normal Android APK the bun agent already dlopens        */
/* libelizainference.so for fused TTS/ASR. This loader binds the         */
/* streaming-LLM + tokenize/embed symbols on the SAME library so TEXT    */
/* generation runs through the fused, MTP/KV-quant-optimized path. It is */
/* the SOLE text backend on AOSP — gated on the ABI-v9 probes. When the  */
/* fused lib is absent or too old the gate refuses and the caller fails  */
/* loud (local text inference unavailable); there is no libllama         */
/* fallback.                                                             */
/* -------------------------------------------------------------------- */

const ELIZA_POOLING_MEAN = 1;

/** Map an `AospLoadModelArgs` KV-cache type onto the fused config string. */
function fusedCacheTypeName(
  value: AospLoadModelArgs["cacheTypeK"] | undefined,
): string | null {
  return value && value.length > 0 ? value : null;
}

/**
 * Build the bun:ffi pointer helpers the streaming binding needs from a
 * loaded `BunFfiModule` + its symbol table (for `eliza_inference_free_string`).
 */
function makeFusedFfiHelpers(
  ffi: BunFfiModule,
  symbols: Record<string, (...args: unknown[]) => unknown>,
): AospFfiPointerHelpers {
  return {
    // bun:ffi `FFIType.ptr` arguments take a NUMBER `Pointer`, not a bigint —
    // handing a bigint throws "Unable to convert <addr> to a pointer". Return
    // bun's native `ptr()` result verbatim (a number); only the explicit
    // `usize`/`u64` args (text_len, the stream handle) are widened to bigint at
    // their call sites. (create() worked because it used ffi.ptr directly.)
    ptr: (view: ArrayBufferView) => {
      const p = ffi.ptr(view);
      return typeof p === "bigint" ? Number(p) : p;
    },
    takeError: (buf: Buffer) => {
      const raw = readFfiPointer(ffi, buf, 0);
      if (!raw || raw === 0n) return null;
      let text: string | null = null;
      try {
        text = ffi.CString ? new ffi.CString(Number(raw)).toString() : null;
      } catch {
        text = null;
      }
      try {
        symbols.eliza_inference_free_string?.(raw);
      } catch {}
      return text;
    },
    cString,
  };
}

interface AospFusedTextLoaderState {
  ffi: BunFfiModule;
  symbols: Record<string, (...args: unknown[]) => unknown>;
  helpers: AospFfiPointerHelpers;
  close: () => void;
  ctx: bigint;
  binding: AospFusedStreamingLlmBinding;
  bundleRoot: string;
  modelPath: string;
  gpuLayers?: number;
  contextSize: number | null;
  draftModelPath: string | null;
  /** Set after a one-time f16 retry when the build rejects KV-quant. */
  kvQuantRejected?: boolean;
}

/**
 * Tokenize `text` against the fused context via `eliza_inference_tokenize`,
 * copying the malloc'd `int*` buffer into a JS-owned `Int32Array` and freeing
 * the native allocation. Mirrors the desktop binding's `tokenize`.
 */
function tokenizeFused(
  state: AospFusedTextLoaderState,
  text: string,
): Int32Array {
  const { ffi, symbols, helpers } = state;
  const tokenize = symbols.eliza_inference_tokenize;
  const freeTokens = symbols.eliza_inference_free_tokens;
  if (typeof tokenize !== "function" || typeof freeTokens !== "function") {
    throw new Error(
      "[aosp-local-inference] fused tokenize unavailable (eliza_inference_tokenize not exported)",
    );
  }
  const textBuf = cString(text);
  // text_len excludes the trailing NUL.
  const textLen = Math.max(0, textBuf.length - 1);
  const outTokensPtr = new BigUint64Array(1);
  const outN = new BigUint64Array(1);
  const err = Buffer.alloc(8);
  const rc = tokenize(
    state.ctx,
    helpers.ptr(textBuf),
    BigInt(textLen),
    // add_special=1, parse_special=1 — render Gemma control tokens as real
    // control tokens (the prompt is already Gemma-formatted upstream).
    1,
    1,
    helpers.ptr(outTokensPtr),
    helpers.ptr(outN),
    helpers.ptr(err),
  ) as number;
  if (rc !== 0) {
    throw new Error(
      helpers.takeError(err) ??
        `[aosp-local-inference] fused tokenize rc=${rc}`,
    );
  }
  const n = Number(outN[0] ?? 0n);
  const tokensRaw = outTokensPtr[0] ?? 0n;
  if (n === 0) {
    if (tokensRaw !== 0n) freeTokens(tokensRaw);
    return new Int32Array(0);
  }
  try {
    if (typeof ffi.toArrayBuffer !== "function") {
      throw new Error(
        "[aosp-local-inference] bun:ffi toArrayBuffer unavailable; cannot read fused tokens",
      );
    }
    // bun:ffi `toArrayBuffer` takes a NUMBER pointer (the `Pointer` type), not a
    // bigint — passing the bigint `tokensRaw` throws "Unable to convert <n> to a
    // pointer". `tokensRaw` is a real heap address (< 2^53) so Number() is exact.
    const view = ffi.toArrayBuffer(Number(tokensRaw), 0, n * 4);
    return new Int32Array(new Uint8Array(view).slice(0, n * 4).buffer);
  } finally {
    freeTokens(tokensRaw);
  }
}

/** Embed `input` via the fused `eliza_inference_embed`. */
function embedFused(
  state: AospFusedTextLoaderState,
  input: string,
): { embedding: number[]; tokens: number } {
  const { symbols, helpers } = state;
  const embed = symbols.eliza_inference_embed;
  if (typeof embed !== "function") {
    throw new Error(
      "[aosp-local-inference] fused embed unavailable (eliza_inference_embed not exported)",
    );
  }
  const textBuf = cString(input);
  const textLen = Math.max(0, textBuf.length - 1);
  const cap = 4096;
  const outEmbedding = new Float32Array(cap);
  const outDim = new Int32Array(1);
  const err = Buffer.alloc(8);
  const rc = embed(
    state.ctx,
    helpers.ptr(textBuf),
    BigInt(textLen),
    ELIZA_POOLING_MEAN,
    helpers.ptr(outEmbedding),
    BigInt(cap),
    helpers.ptr(outDim),
    helpers.ptr(err),
  ) as number;
  if (rc !== 0) {
    throw new Error(
      helpers.takeError(err) ?? `[aosp-local-inference] fused embed rc=${rc}`,
    );
  }
  const dim = outDim[0] ?? 0;
  if (dim <= 0 || dim > cap) {
    throw new Error(
      `[aosp-local-inference] fused embed returned out-of-range n_embd=${dim}`,
    );
  }
  return { embedding: Array.from(outEmbedding.subarray(0, dim)), tokens: 0 };
}

/**
 * The libelizainference symbol table the fused text loader binds. Mirrors the
 * desktop binding's dlopen defs (ABI v9). `T.usize ?? T.ptr` is used for raw
 * pointer handles handed back into C.
 */
function dlopenFusedTextLib(ffi: BunFfiModule, libPath: string) {
  const T = ffi.FFIType;
  const usize = T.usize ?? T.ptr;
  return ffi.dlopen(libPath, {
    eliza_inference_create: { args: [T.ptr, T.ptr], returns: T.ptr },
    eliza_inference_destroy: { args: [T.ptr], returns: T.void },
    eliza_inference_mmap_acquire: {
      args: [T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_free_string: { args: [usize], returns: T.void },
    eliza_inference_free_tokens: { args: [usize], returns: T.void },
    eliza_inference_llm_stream_supported: { args: [], returns: T.i32 },
    eliza_inference_llm_mtp_supported: { args: [], returns: T.i32 },
    eliza_inference_llm_kv_quant_supported: { args: [], returns: T.i32 },
    eliza_inference_llm_stream_open: {
      args: [T.ptr, T.ptr, T.ptr],
      returns: T.ptr,
    },
    eliza_inference_llm_stream_prefill: {
      args: [usize, T.ptr, usize, T.ptr],
      returns: T.i32,
    },
    eliza_inference_llm_stream_next: {
      args: [usize, T.ptr, usize, T.ptr, T.ptr, usize, T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_llm_stream_cancel: { args: [usize], returns: T.i32 },
    eliza_inference_llm_stream_close: { args: [usize], returns: T.void },
    eliza_inference_tokenize: {
      args: [T.ptr, T.ptr, usize, T.i32, T.i32, T.ptr, T.ptr, T.ptr],
      returns: T.i32,
    },
    eliza_inference_embed: {
      args: [T.ptr, T.ptr, usize, T.i32, T.ptr, usize, T.ptr, T.ptr],
      returns: T.i32,
    },
  });
}

/**
 * Build the fused libelizainference text loader, or return `null` when the
 * fused lib is absent / too old (no streaming-LLM, MTP, or KV-quant support —
 * the ABI-v9 gate). The fused lib is the SOLE text backend on AOSP; on `null`
 * the caller surfaces a loud local-unavailable failure (there is no
 * libllama fallback).
 *
 * The returned loader satisfies the `AospLoader` shape the bootstrap drives
 * (`loadModel` / `generate` / `embed` / …). The `EliInferenceContext` is
 * created lazily on the first `loadModel`, with the bundle root derived from
 * the resolved `modelPath` — so the loader can be built at boot even before
 * the model has been downloaded (the lifecycle resolves/auto-downloads the
 * GGUF, then calls `loadModel(target)`). `generate` tokenizes the Gemma
 * prompt and runs the streaming open→prefill→next→close loop.
 */
export async function tryBuildAospFusedTextLoader(): Promise<AospLoader | null> {
  const libPath = resolveElizaInferenceLibPath();
  if (!existsSync(libPath)) {
    writeAospLlamaDebugLog("bootstrap:fusedText:libMissing", { libPath });
    return null;
  }

  const ffi = await loadAospVoiceFfi();
  const lib = dlopenFusedTextLib(ffi, libPath);
  const symbols = lib.symbols;
  const helpers = makeFusedFfiHelpers(ffi, symbols);

  // Probe support against the LIBRARY (no context needed) before creating one.
  const streamProbe = symbols.eliza_inference_llm_stream_supported;
  const mtpProbe = symbols.eliza_inference_llm_mtp_supported;
  const kvProbe = symbols.eliza_inference_llm_kv_quant_supported;
  const libSupportsFusedText =
    typeof streamProbe === "function" &&
    streamProbe() === 1 &&
    typeof mtpProbe === "function" &&
    mtpProbe() === 1 &&
    typeof kvProbe === "function" &&
    kvProbe() === 1;
  if (!libSupportsFusedText) {
    writeAospLlamaDebugLog("bootstrap:fusedText:unsupported", {
      libPath,
      stream: typeof streamProbe === "function" ? streamProbe() : null,
      mtp: typeof mtpProbe === "function" ? mtpProbe() : null,
      kvQuant: typeof kvProbe === "function" ? kvProbe() : null,
    });
    try {
      lib.close();
    } catch {}
    logger.error(
      "[aosp-local-inference] fused libelizainference present but lacks streaming-LLM/MTP/KV-quant (ABI <v9); local text inference unavailable",
    );
    return null;
  }

  let state: AospFusedTextLoaderState | null = null;

  const destroyState = (): void => {
    if (!state) return;
    try {
      state.symbols.eliza_inference_destroy?.(state.ctx);
    } catch {}
    state = null;
  };

  const loader: AospLoader = {
    currentModelPath: () => state?.modelPath ?? null,

    async loadModel(args: AospLoadModelArgs): Promise<void> {
      // One EliInferenceContext per bundle: the C side resolves text vs
      // embedding regions per call (`llm_stream_*` vs `embed`), so chat and
      // embedding loads SHARE the context — we never destroy + recreate when
      // the lifecycle swaps roles (that would evict the hot text model). The
      // context is created lazily on the first load; its bundle root is
      // derived from the resolved model path so the loader does not need a
      // pre-staged bundle at boot.
      ensureFusedTextBundleLayout(
        args.modelPath,
        state?.bundleRoot ?? resolveBundleRootFromModelPath(args.modelPath),
      );
      if (!state) {
        const bundleRoot = resolveBundleRootFromModelPath(args.modelPath);
        const errCreate = Buffer.alloc(8);
        const ctx = symbols.eliza_inference_create(
          ffi.ptr(cString(bundleRoot)),
          ffi.ptr(errCreate),
        ) as bigint;
        if (isFfiNullPointer(ctx)) {
          throw new Error(
            `[aosp-local-inference] fused create failed: ${readFfiStringAndFree(ffi, symbols, errCreate)}`,
          );
        }
        state = {
          ffi,
          symbols,
          helpers,
          close: lib.close,
          ctx,
          binding: createAospStreamingLlmBinding({
            ctx,
            symbols: asFusedLlmSymbols(symbols),
            helpers,
          }),
          bundleRoot,
          modelPath: args.modelPath,
          contextSize: args.contextSize ?? null,
          draftModelPath: null,
        };
      }

      // Only chat-shaped loads carry text-generation tuning (MTP drafter, a
      // fork KV-quant cache type, or offloaded GPU layers). Embedding loads
      // (gpuLayers 0 + f16 KV, no drafter) must not clobber the streaming
      // config, so detect + skip them.
      const kvCacheTypes = {
        cacheTypeK: fusedCacheTypeName(args.cacheTypeK ?? args.kvCacheType?.k),
        cacheTypeV: fusedCacheTypeName(args.cacheTypeV ?? args.kvCacheType?.v),
      };
      const draftModelPath = args.draftModelPath ?? null;
      const isChatShaped =
        draftModelPath !== null ||
        (typeof args.gpuLayers === "number" && args.gpuLayers > 0) ||
        (kvCacheTypes.cacheTypeK !== null &&
          kvCacheTypes.cacheTypeK !== "f16") ||
        (kvCacheTypes.cacheTypeV !== null && kvCacheTypes.cacheTypeV !== "f16");
      if (!isChatShaped && state.modelPath !== args.modelPath) {
        // Embedding (or otherwise untuned) load against the shared context —
        // no streaming-config rebuild needed.
        return;
      }

      state.modelPath = args.modelPath;
      state.contextSize = args.contextSize ?? state.contextSize ?? null;
      state.draftModelPath = draftModelPath;
      if (typeof args.gpuLayers === "number") {
        state.gpuLayers = args.gpuLayers;
      }
      state.binding = createAospStreamingLlmBinding({
        ctx: state.ctx,
        symbols: asFusedLlmSymbols(symbols),
        helpers,
        ...(typeof args.gpuLayers === "number"
          ? { gpuLayers: args.gpuLayers }
          : {}),
        kvCacheTypes,
      });
      writeAospLlamaDebugLog("bootstrap:fusedText:loaded", {
        model: path.basename(args.modelPath),
        gpuLayers: args.gpuLayers ?? null,
        cacheTypeK: kvCacheTypes.cacheTypeK,
        cacheTypeV: kvCacheTypes.cacheTypeV,
        draftModelPath,
      });
      logger.info(
        `[aosp-local-inference] fused libelizainference text backend ready (model=${path.basename(args.modelPath)}, mtpDrafter=${draftModelPath ? path.basename(draftModelPath) : "none"})`,
      );
    },

    async unloadModel(): Promise<void> {
      destroyState();
    },

    async generate(args): Promise<string> {
      const active = state;
      if (!active) {
        throw new Error(
          "[aosp-local-inference] fused text generate called before loadModel",
        );
      }
      if (args.signal?.aborted) {
        throw new Error("[aosp-local-inference] fused text generate aborted");
      }
      const promptTokens = tokenizeFused(active, args.prompt);
      const config: AospLlmStreamConfig = {
        maxTokens: args.maxTokens ?? 512,
        temperature: args.temperature ?? 0.7,
        topP: 0.9,
        topK: 40,
        repeatPenalty: 1.1,
        slotId: -1,
        promptCacheKey: null,
        // MTP drafter path drives speculative decode; null = target-only.
        draftMin: active.draftModelPath ? 1 : 0,
        draftMax: active.draftModelPath ? 16 : 0,
        mtpDrafterPath: active.draftModelPath,
        disableThinking: false,
        contextSize: active.contextSize,
      };
      const runStream = async () => {
        const result = await streamGenerate(active.binding, {
          ctx: active.ctx,
          config,
          promptTokens,
          ...(args.signal ? { signal: args.signal } : {}),
          ...(args.onTextChunk ? { onTextChunk: args.onTextChunk } : {}),
        });
        return result.text;
      };
      try {
        return await runStream();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Some fused-lib builds reject a quantized V cache without flash_attn
        // ("V cache quantization requires flash_attn" → llm_stream_open fails
        // to init the llama context). Retry ONCE with f16 KV so local text
        // inference stays alive, and log loudly — the eliza-1 KV-quant memory
        // optimization is disabled for the rest of this load.
        const kvQuantRejection =
          /flash_attn|failed to init llama context/i.test(message);
        if (active.kvQuantRejected || !kvQuantRejection) {
          throw err;
        }
        active.kvQuantRejected = true;
        logger.warn(
          `[aosp-local-inference] fused llm_stream_open rejected the KV-quant cache config (${message}); retrying with f16 KV cache — eliza-1 KV-quant memory optimization DISABLED for this model load. Set ELIZA_LLAMA_KV_TYPE_K/V=f16 to silence this retry, or ship a fused lib with flash_attn wired for quantized V cache.`,
        );
        writeAospLlamaDebugLog("bootstrap:fusedText:kvQuantRejected", {
          message,
        });
        active.binding = createAospStreamingLlmBinding({
          ctx: active.ctx,
          symbols: asFusedLlmSymbols(active.symbols),
          helpers: active.helpers,
          ...(typeof active.gpuLayers === "number"
            ? { gpuLayers: active.gpuLayers }
            : {}),
          kvCacheTypes: { cacheTypeK: "f16", cacheTypeV: "f16" },
        });
        return await runStream();
      }
    },

    async embed(args): Promise<{ embedding: number[]; tokens: number }> {
      const active = state;
      if (!active) {
        throw new Error(
          "[aosp-local-inference] fused embed called before loadModel",
        );
      }
      return embedFused(active, args.input);
    },
  };

  logger.info(
    "[aosp-local-inference] fused libelizainference text loader selected (ABI v9 streaming-LLM + MTP + KV-quant)",
  );
  return loader;
}

/**
 * Register the AOSP llama.cpp FFI loader and matching ModelType handlers
 * on the runtime.
 *
 * Returns true when handlers were registered, false on every other path
 * (env opt-in not set, runtime missing `registerModel`, FFI dlopen
 * failure). All failures are logged at `error` because `ELIZA_LOCAL_LLAMA=1`
 * is an explicit operator opt-in — silent fall-through to "No handler"
 * crashes is unacceptable.
 */
export async function ensureAospLocalInferenceHandlers(
  runtime: AgentRuntime,
): Promise<boolean> {
  // console.log because logger.info routing in the mobile agent process
  // sometimes hides early bootstrap output behind the pino transport,
  // and we need a visible signal that the post-startEliza hook ran.
  console.log("[aosp-local-inference] bootstrap entered");
  if (process.env.ELIZA_LOCAL_LLAMA?.trim() !== "1") {
    console.log(
      "[aosp-local-inference] ELIZA_LOCAL_LLAMA != '1', returning early",
    );
    return false;
  }
  if (registeredRuntimes.has(runtime)) {
    console.log("[aosp-local-inference] handlers already registered");
    return true;
  }

  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    console.error(
      "[aosp-local-inference] runtime missing getModel/registerModel",
    );
    logger.error(
      "[aosp-local-inference] Runtime is missing getModel/registerModel; cannot wire handlers.",
    );
    return false;
  }
  console.log("[aosp-local-inference] runtime has model-registration surface");

  // Build the fused libelizainference text loader (ABI-v9 streaming-LLM + MTP
  // + KV-quant). This is the SOLE text backend on AOSP: it runs on the SAME
  // libelizainference handle the bun agent uses for voice, so text + TTS + ASR
  // share one native library. When the fused lib is absent or too old the
  // loader is null and we fail LOUD — `ELIZA_LOCAL_LLAMA=1` is an explicit
  // operator opt-in, so a missing local backend must surface clearly (the
  // cloud-fallback handler at priority -1 then routes recoverable failures to
  // a cloud provider via the local-unavailable classifier).
  console.log("[aosp-local-inference] building fused text loader…");
  const fusedTextLoader = await tryBuildAospFusedTextLoader();
  console.log(
    `[aosp-local-inference] fused text loader ${fusedTextLoader ? "ready" : "unavailable"}`,
  );
  if (!fusedTextLoader) {
    console.error("[aosp-local-inference] fused text loader unavailable");
    logger.error(
      "[aosp-local-inference] fused libelizainference text loader unavailable (lib absent or pre-ABI-v9); TEXT_* handlers NOT wired. Local text inference is unavailable.",
    );
    return false;
  }

  // Inference memory policy (#11760): free the loaded model after a RAM-class
  // idle window so the pinned weights don't keep this process at the top of
  // lmkd's kill list between conversations. Every loader use routes through the
  // instrumented wrapper so the idle clock is accurate; the unload flows
  // through the same lifecycle plumbing the voice handlers' out-of-band
  // eviction already uses (`unloadModel` + `markEvicted` → the next request
  // reloads via `ensureChatLoaded`).
  const inferenceRamClass = classifyInferenceRamClass();
  const idleUnloadMs = resolveInferenceIdleUnloadMs(inferenceRamClass);
  let markLifecycleEvicted: () => void = () => {};
  const idleUnloader = new InferenceIdleUnloader({
    idleUnloadMs,
    // The bun agent never receives onTrimMemory (it is not an Android
    // component), so /proc/meminfo MemAvailable is its pressure signal.
    pressureCheck: makeProcMeminfoPressureCheck(inferenceRamClass),
    isLoaded: () => fusedTextLoader.currentModelPath() !== null,
    unload: async () => {
      await fusedTextLoader.unloadModel();
      markLifecycleEvicted();
      writeAospLlamaDebugLog("bootstrap:idleUnload:released", {
        idleUnloadMs,
        ramClass: inferenceRamClass,
      });
    },
    logger: {
      info: (msg) => logger.info(msg),
      warn: (msg) => logger.warn(msg),
    },
  });
  const textLoader = instrumentLoaderForIdleTracking(
    fusedTextLoader,
    idleUnloader,
  );
  routeActivationLoader = textLoader;

  const lifecycle = makeLoaderLifecycle(textLoader);
  markLifecycleEvicted = lifecycle.markEvicted;
  idleUnloader.start();
  logger.info(
    `[aosp-local-inference] inference memory policy: ramClass=${inferenceRamClass} idleUnloadMs=${idleUnloadMs} (#11760)`,
  );
  // TEXT_EMBEDDING is wired unconditionally: chat + embedding loads share one
  // fused EliInferenceContext, and the C side resolves the text vs embedding
  // region per call (`llm_stream_*` vs `embed`), so there is no cross-mode
  // state bleed to gate against.
  const slots: Array<(typeof ModelType)[keyof typeof ModelType]> = [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
    ModelType.TEXT_EMBEDDING,
    ModelType.TEXT_TO_SPEECH,
  ];
  // TRANSCRIPTION is registered ONLY when the ASR assets are actually on disk.
  // Registering it unconditionally made the readiness probe report local
  // transcription as available while every invocation threw "requires ASR
  // assets". TEXT_TO_SPEECH stays unconditional because its handler degrades to
  // the system TTS engine when neural assets are absent — TRANSCRIPTION has no
  // such in-handler fallback (native SpeechRecognizer covers STT separately).
  const asrAssetsPresent = aospAsrAssetsPresent();
  if (asrAssetsPresent) {
    slots.push(ModelType.TRANSCRIPTION);
  } else {
    logger.info(
      "[aosp-local-inference] ASR assets absent under the chat bundle; NOT registering a local TRANSCRIPTION handler (native SpeechRecognizer owns on-device STT). Readiness probes will correctly report transcription as unavailable.",
    );
  }
  const baseKokoroTextToSpeechHandler =
    makeAospFusedKokoroTextToSpeechHandler();
  let foregroundKokoroTextToSpeechUsed = false;
  const textToSpeechHandler = makeAospTextToSpeechHandler({
    kokoro: baseKokoroTextToSpeechHandler,
    onForegroundUse: () => {
      foregroundKokoroTextToSpeechUsed = true;
    },
  });
  for (const modelType of slots) {
    const handler =
      modelType === ModelType.TEXT_EMBEDDING
        ? makeEmbeddingHandler(textLoader, lifecycle)
        : modelType === ModelType.TEXT_TO_SPEECH
          ? textToSpeechHandler
          : modelType === ModelType.TRANSCRIPTION
            ? makeAospTranscriptionHandler(textLoader, lifecycle.markEvicted)
            : makeGenerateHandler(textLoader, lifecycle);
    runtimeWithRegistration.registerModel(
      modelType,
      handler,
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
    );
  }

  // Register a cloud-fallback wrapper at priority -1 for the text-generation
  // slots (NOT embeddings — there's no cloud embedding fallback on this
  // bundle today). The wrapper tries local first; on a classified
  // recoverable failure it delegates to the next registered TEXT_* handler.
  // The runtime always picks the local handler first by priority — this
  // sits one rung below as the safety net.
  const fallbackSlots: Array<(typeof ModelType)[keyof typeof ModelType]> = [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
  ];
  for (const modelType of fallbackSlots) {
    runtimeWithRegistration.registerModel(
      modelType,
      makeCloudFallbackHandler(textLoader, lifecycle, modelType),
      `${PROVIDER}-cloud-fallback`,
      CLOUD_FALLBACK_PRIORITY,
    );
  }

  // Pre-warm the chat model so the first incoming chat request doesn't
  // pay the fused context-create + first-load cost inside the request
  // handler. The load is best-effort: if the bundled chat file is missing
  // we let the
  // request handler bubble up a clear error instead of crashing the
  // boot. ensureChatLoaded is also memoized at the lifecycle layer, so
  // calling it here doesn't conflict with the first real request.
  void lifecycle.ensureChatLoaded().catch((err) => {
    logger.warn(
      "[aosp-local-inference] Chat model pre-warm failed (will retry on first request): " +
        (err instanceof Error ? err.message : String(err)),
    );
  });
  prewarmAospKokoroTextToSpeechHandler(baseKokoroTextToSpeechHandler, {
    shouldSkip: () => foregroundKokoroTextToSpeechUsed,
  });

  const registeredList = `TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING / TEXT_TO_SPEECH${
    asrAssetsPresent ? " / TRANSCRIPTION" : ""
  }`;
  console.log(
    `[aosp-local-inference] registered ${PROVIDER} handlers for ${registeredList} (priority ${LOCAL_INFERENCE_PRIORITY}, text backend fused-libelizainference)`,
  );
  logger.info(
    `[aosp-local-inference] Registered ${PROVIDER} handlers for ${registeredList} at priority ${LOCAL_INFERENCE_PRIORITY} (text backend fused-libelizainference)`,
  );
  registeredRuntimes.add(runtime);
  return true;
}
