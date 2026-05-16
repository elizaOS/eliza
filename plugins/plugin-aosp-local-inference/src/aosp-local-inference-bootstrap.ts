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
 * branch of `ensure-local-inference-handler.ts`. It registers the AOSP
 * native FFI loader (already implemented in `aosp-llama-adapter.ts`) and
 * wires the four ModelType handlers the runtime needs. No assignments,
 * no model registry, no routing-policy — single loader, single model
 * (the one staged into the APK at build time and loaded on first call).
 *
 * Why not import from `@elizaos/app-core` directly? `@elizaos/app-core`
 * already depends on `@elizaos/agent`, so an `agent → app-core` import
 * creates a hard cyclic workspace dependency that breaks `bun install`
 * and CI even when the bundler can inline the cycle. Keeping the AOSP
 * registration here avoids the cycle entirely.
 *
 * Activation: only fires when `ELIZA_LOCAL_LLAMA === "1"`, which is
 * the AOSP build flag set by `ElizaAgentService.java` before
 * `Runtime.exec`'ing the bun process. On every other build the call is
 * a logged no-op.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
  resolveStateDir,
  type TextEmbeddingParams,
  type TextToSpeechParams,
  type TranscriptionParams,
} from "@elizaos/core";
import {
  findKokoroVoice,
  type KokoroEngineDiscoveryResult,
  KokoroOnnxRuntime,
  type KokoroRuntime,
  KokoroTtsBackend,
  resolveKokoroEngineConfig,
} from "@elizaos/shared";
import { writeAospLlamaDebugLog } from "./aosp-debug-log.js";
import {
  registerAospLlamaLoader,
  resolveLibllamaPath,
} from "./aosp-llama-adapter.js";

const SERVICE_NAME = "localInferenceLoader";
const PROVIDER = "eliza-aosp-llama";
const registeredRuntimes = new WeakSet<AgentRuntime>();
const AOSP_ACTIVE_MODEL_STATE_FILE = "aosp-active.json";

/**
 * Same priority band as cloud / direct provider plugins. Routing-policy
 * sits at MAX_SAFE_INTEGER and decides between candidates per-request;
 * this number only controls whether `runtime.getModel(TEXT_SMALL)` finds
 * a handler at all when no router is installed.
 *
 * Mirrors `ensure-local-inference-handler.ts:LOCAL_INFERENCE_PRIORITY`.
 */
const LOCAL_INFERENCE_PRIORITY = 0;

interface AospLoader {
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
     * Per-request abort signal. Forwarded into the FFI decode loop in
     * `aosp-llama-adapter.ts`; the loop checks `signal.aborted` between
     * chunks and between sampled tokens and throws an AbortError when
     * the caller cancels.
     */
    signal?: AbortSignal;
  }): Promise<string>;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
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

interface AospLoadModelArgs {
  modelPath: string;
  contextSize?: number;
  maxThreads?: number;
  useGpu?: boolean;
  draftModelPath?: string;
  draftContextSize?: number;
  draftMin?: number;
  draftMax?: number;
  kvCacheType?: {
    k?: "f16" | "tbq3_0" | "tbq4_0" | "qjl1_256" | "q4_polar";
    v?: "f16" | "tbq3_0" | "tbq4_0" | "qjl1_256" | "q4_polar";
  };
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
 * bun:ffi llama.cpp backend. v5 Stage-1 calls pass native chat `messages`
 * and leave legacy `prompt` unset; without this bridge the native adapter sees
 * an empty string and llama_tokenize returns zero tokens.
 *
 * The format mirrors the regular mobile bridge fallback: model-agnostic
 * role-labelled text plus a trailing assistant turn marker. We deliberately do
 * not hardcode Llama/Qwen special tokens here; models with baked chat templates
 * are handled by other backends, while this path must stay tokenizer-neutral.
 */
export function flattenGenerateTextParamsForAospPrompt(
  params: GenerateTextParams,
): string {
  if (typeof params.prompt === "string" && params.prompt.length > 0) {
    return params.prompt;
  }

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
      blocks.push(`system:\n${params.system.trim()}`);
    }
    for (const message of messages) {
      const content = renderMessageContent(message.content);
      if (!content) continue;
      blocks.push(`${normalizeChatRole(message.role)}:\n${content}`);
    }
    if (blocks.length > 0) {
      const lastRole = normalizeChatRole(messages[messages.length - 1]?.role);
      if (lastRole !== "assistant") {
        blocks.push("assistant:");
      }
      return blocks.join("\n\n");
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
    return `system:\n${params.system.trim()}\n\nassistant:`;
  }

  return "";
}

export function buildGenerateArgsFromParams(
  params: GenerateTextParams,
): Parameters<AospLoader["generate"]>[0] {
  const args: Parameters<AospLoader["generate"]>[0] = {
    prompt: flattenGenerateTextParamsForAospPrompt(params),
  };
  if (params.stopSequences !== undefined) {
    args.stopSequences = params.stopSequences;
  }
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

function dflashServerSpawnAllowed(): boolean {
  const explicitServerSpawn = readBooleanEnv("ELIZA_DFLASH_SERVER_SPAWN");
  if (explicitServerSpawn !== null) {
    return explicitServerSpawn;
  }

  // ELIZA_DFLASH expresses the desired inference mode. It must not opt a
  // stock APK into the retired child-process llama-server path. Android
  // production builds only enable speculation through an in-process FFI
  // implementation that explicitly reports support; server spawn is a
  // diagnostic escape hatch and requires ELIZA_DFLASH_SERVER_SPAWN=1.
  return false;
}

function inProcessDflashRequested(): boolean {
  const explicitDflash = readBooleanEnv("ELIZA_DFLASH");
  if (explicitDflash !== null) {
    return explicitDflash;
  }
  return readBooleanEnv("ELIZA_DFLASH_REQUIRED") === true;
}

function resolveDflashDrafterPath(modelPath: string): string | null {
  const explicit = process.env.ELIZA_DFLASH_DRAFTER_PATH?.trim();
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  if (!inProcessDflashRequested() && !dflashServerSpawnAllowed()) {
    return null;
  }
  const textDir = path.dirname(modelPath);
  const bundleDir =
    path.basename(textDir).toLowerCase() === "text"
      ? path.dirname(textDir)
      : path.dirname(modelPath);
  const dflashDir = path.join(bundleDir, "dflash");
  if (!existsSync(dflashDir)) return null;
  try {
    const candidates = readdirSync(dflashDir)
      .filter((name) => {
        const lower = name.toLowerCase();
        return lower.endsWith(".gguf") && lower.includes("draft");
      })
      .sort();
    for (const name of candidates) {
      const candidate = path.join(dflashDir, name);
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
    const draftModelPath = resolveDflashDrafterPath(modelPath);
    return {
      modelPath,
      contextSize: readPositiveIntEnv("ELIZA_LLAMA_N_CTX", 4096),
      draftModelPath: draftModelPath ?? undefined,
      draftContextSize: draftModelPath
        ? readPositiveIntEnv("ELIZA_DFLASH_DRAFT_N_CTX", 2048)
        : undefined,
      draftMin: draftModelPath
        ? readPositiveIntEnv("ELIZA_DFLASH_DRAFT_MIN", 1)
        : undefined,
      draftMax: draftModelPath
        ? readPositiveIntEnv("ELIZA_DFLASH_DRAFT_MAX", 16)
        : undefined,
      useGpu: false,
      kvCacheType: {
        k: "qjl1_256",
        v: "q4_polar",
      },
    };
  }
  return {
    modelPath,
    contextSize: readPositiveIntEnv("ELIZA_LLAMA_EMBEDDING_N_CTX", 512),
    useGpu: false,
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
    if (
      msg.includes("no bundled") ||
      msg.includes("not installed in this build") ||
      msg.includes("node-llama-cpp is not installed") ||
      msg.includes("no local model is active") ||
      msg.includes("dlopen") ||
      msg.includes("missing libllama") ||
      msg.includes("aosp-llama] no") ||
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
      msg.includes("llama_decode") ||
      msg.includes("llama_tokenize") ||
      msg.includes("llama_sampler") ||
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

function isAospLoaderShape(value: unknown): value is AospLoader {
  if (!value || typeof value !== "object") return false;
  const loader = value as Partial<AospLoader>;
  return (
    typeof loader.loadModel === "function" &&
    typeof loader.unloadModel === "function" &&
    typeof loader.generate === "function" &&
    typeof loader.embed === "function" &&
    typeof loader.currentModelPath === "function"
  );
}

/**
 * Capture the loader from the (name, impl) registerService overload that
 * `registerAospLlamaLoader` uses.
 *
 * The upstream `AgentRuntime.registerService` only accepts `ServiceClass`
 * (a constructor with a static `serviceType` property), not the
 * `(name: string, impl: object)` overload. When the AOSP adapter calls
 * `runtime.registerService("localInferenceLoader", loaderImpl)` the runtime
 * sees the string as the `serviceDef`, finds no `.serviceType`, logs a
 * warn, and silently returns. As a result `runtime.getService(...)` for
 * the loader returns null and TEXT_* handlers never get wired.
 *
 * Rather than fork the adapter, install a transient interceptor on
 * `runtime.registerService` that recognizes the (string, impl) overload,
 * captures the impl into a local closure variable, and forwards every
 * other call to the original. We restore the original method after
 * `registerAospLlamaLoader` resolves so subsequent service registrations
 * (plugins calling `registerService(SomeServiceClass)`) keep working.
 */
async function callRegisterAndCaptureLoader(
  runtime: AgentRuntime,
): Promise<{ ok: boolean; loader: AospLoader | null }> {
  const target = runtime as AgentRuntime & {
    registerService: (...args: unknown[]) => unknown;
  };
  const originalRegisterService = target.registerService.bind(runtime);
  let captured: AospLoader | null = null;
  target.registerService = ((...args: unknown[]) => {
    if (args.length === 2 && typeof args[0] === "string") {
      if (args[0] === SERVICE_NAME && isAospLoaderShape(args[1])) {
        captured = args[1];
      }
      return undefined;
    }
    return originalRegisterService(...args);
  }) as (typeof target)["registerService"];
  let ok = false;
  try {
    const registrationRuntime: Parameters<typeof registerAospLlamaLoader>[0] = {
      registerService: target.registerService,
    };
    ok = await registerAospLlamaLoader(registrationRuntime);
  } finally {
    target.registerService = originalRegisterService;
  }
  return { ok, loader: captured };
}

/**
 * Resolve the bundled chat / embedding GGUF paths shipped under
 * `$ELIZA_STATE_DIR/local-inference/models/`. Both files are staged by
 * the AOSP build (`scripts/elizaos/stage-default-models.mjs`) and
 * extracted by `ElizaAgentService.extractAssetsIfNeeded` before bun
 * starts. We pick the role from the sibling `manifest.json` so a future
 * model swap doesn't need a code change.
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
    !lowerPath.includes("/dflash/") &&
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
    id: "eliza-1-2b",
    hfRepo: "elizalabs/eliza-1",
    ggufFile: "bundles/2b/text/eliza-1-2b-128k.gguf",
  },
  embedding: {
    id: "eliza-1-embedding",
    hfRepo: "elizalabs/eliza-1",
    ggufFile: "bundles/2b/embedding/eliza-1-embedding.gguf",
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
        !lowerPath.includes("/dflash/") &&
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
 * Per-modelType auto-load gate. We track which model role is currently
 * loaded so a chat handler doesn't try to swap-in the embedding model
 * (and vice versa) on every call. Promise-shaped so two concurrent
 * requests share the single load.
 */
type LoadedRole = "chat" | "embedding" | null;
function makeLoaderLifecycle(loader: AospLoader): {
  ensureChatLoaded(): Promise<void>;
  ensureEmbeddingLoaded(): Promise<void>;
} {
  let currentRole: LoadedRole = null;
  let inflight: Promise<void> | null = null;
  const modelsDir = resolveBundledModelsDir();
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
  async function loadRole(role: "chat" | "embedding"): Promise<void> {
    if (currentRole === role) return;
    if (inflight) return inflight;
    let target = role === "chat" ? resolved.chat : resolved.embedding;
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
  };
}

/**
 * Internal: attempt local generate and classify the outcome explicitly.
 * The wrapper at priority -1 consumes this and decides whether to forward
 * to a cloud handler.
 */
async function tryLocalGenerate(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
  params: GenerateTextParams,
): Promise<LocalGenerateOutcome> {
  try {
    await lifecycle.ensureChatLoaded();
  } catch (err) {
    const cls = classifyLocalError(err);
    return cls.fallback
      ? {
          kind: "fallback",
          reason: cls.reason,
          cause: err instanceof Error ? err : undefined,
        }
      : Promise.reject(err);
  }
  const args = buildGenerateArgsFromParams(params);
  try {
    const text = await loader.generate(args);
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
  return async (_runtime, params) => {
    writeAospLlamaDebugLog("bootstrap:generate:ensureChat:start", {
      maxTokens: params.maxTokens ?? null,
      hasGrammar:
        typeof params.grammar === "string" && params.grammar.trim().length > 0,
    });
    await lifecycle.ensureChatLoaded();
    writeAospLlamaDebugLog("bootstrap:generate:ensureChat:done");
    // The runtime injects `signal` into `params` from the active streaming
    // context's `abortSignal` when the caller didn't pass one explicitly
    // (see runtime.ts useModel: paramsAsStreaming.signal ??= abortSignal).
    // We forward it into the FFI decode loop so APP_PAUSE etc. can cancel
    // an in-flight phone-CPU prefill that would otherwise pin the bun
    // process for minutes.
    const args = buildGenerateArgsFromParams(params);
    writeAospLlamaDebugLog("bootstrap:generate:start", {
      promptChars: args.prompt.length,
      maxTokens: args.maxTokens ?? null,
      grammarBytes: args.grammar?.trim().length ?? 0,
    });
    return loader.generate(args);
  };
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

interface AospKokoroTtsHandlerOptions {
  discover?: () => KokoroEngineDiscoveryResult | null;
  runtime?: KokoroRuntime;
  loadOrt?: ConstructorParameters<typeof KokoroOnnxRuntime>[0]["loadOrt"];
}

type AospKokoroOrtLoader = NonNullable<
  ConstructorParameters<typeof KokoroOnnxRuntime>[0]["loadOrt"]
>;

const DEFAULT_AOSP_KOKORO_ORT_MODULE = "onnxruntime-web/wasm";

function wrapKokoroWebOrtModule(
  module: unknown,
): Awaited<ReturnType<AospKokoroOrtLoader>> {
  const candidate = module as {
    default?: unknown;
    env?: { wasm?: { numThreads?: number } };
    InferenceSession?: {
      create: (
        model: unknown,
        opts?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    Tensor?: unknown;
  };
  const ort = (
    candidate.InferenceSession
      ? candidate
      : (candidate.default as typeof candidate | undefined)
  ) as typeof candidate;
  if (!ort?.InferenceSession?.create || !ort.Tensor) {
    throw new Error(
      "[aosp-local-inference] Android Kokoro ORT module is missing InferenceSession/Tensor exports",
    );
  }
  const baseInferenceSession = ort.InferenceSession;
  if (ort.env?.wasm) {
    // Pixel stock-APK Bun currently crashes ONNX Runtime Web's worker path
    // when numThreads > 1 ("Error in worker"). Keep the production default
    // single-threaded, while preserving an explicit env knob for future AOSP
    // / runtime experiments.
    const wasmThreads = readPositiveIntEnv("ELIZA_KOKORO_WASM_THREADS", 1);
    ort.env.wasm.numThreads = wasmThreads;
    logger.info(
      `[aosp-local-inference] Kokoro ORT wasm numThreads=${wasmThreads}`,
    );
  }
  return {
    ...ort,
    InferenceSession: {
      ...baseInferenceSession,
      create: async (modelPath: string, opts?: Record<string, unknown>) => {
        const model = existsSync(modelPath)
          ? readFileSync(modelPath)
          : modelPath;
        return baseInferenceSession.create(model, {
          ...opts,
          executionProviders: ["wasm"],
        });
      },
    },
  } as Awaited<ReturnType<AospKokoroOrtLoader>>;
}

export async function loadAospKokoroOrt(): ReturnType<AospKokoroOrtLoader> {
  const spec = process.env.ELIZA_AOSP_KOKORO_ORT_MODULE?.trim();
  if (!spec || spec === DEFAULT_AOSP_KOKORO_ORT_MODULE) {
    // @ts-ignore onnxruntime-web exposes this runtime subpath without bundled declarations in some workspace tsconfigs.
    const mod = await import("onnxruntime-web/wasm");
    return wrapKokoroWebOrtModule(mod);
  }
  const mod = await import(spec);
  return spec.includes("onnxruntime-web")
    ? wrapKokoroWebOrtModule(mod)
    : (mod as Awaited<ReturnType<AospKokoroOrtLoader>>);
}

function extractSpeechText(params: TextToSpeechParams | string): string {
  if (typeof params === "string") return params;
  if (params && typeof params === "object" && typeof params.text === "string") {
    return params.text;
  }
  throw new Error(
    "[aosp-local-inference] TEXT_TO_SPEECH requires a string or { text } input",
  );
}

function extractSpeechVoice(
  params: TextToSpeechParams | string,
): string | null {
  return typeof params === "object" && params !== null
    ? (params.voice ?? null)
    : null;
}

function extractSpeechSignal(
  params: TextToSpeechParams | string,
): AbortSignal | undefined {
  return typeof params === "object" && params !== null
    ? params.signal
    : undefined;
}

function resolveStagedSpeechVoice(
  params: TextToSpeechParams | string,
  config: KokoroEngineDiscoveryResult,
): string {
  const requested = extractSpeechVoice(params);
  if (!requested) return config.defaultVoiceId;
  const pack = findKokoroVoice(requested);
  if (pack && existsSync(path.join(config.layout.voicesDir, pack.file))) {
    return pack.id;
  }
  return config.defaultVoiceId;
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
 * AOSP Kokoro TEXT_TO_SPEECH handler.
 *
 * The Kokoro model/voice discovery and runtime live in
 * `@elizaos/shared/local-inference`; this package only supplies the Android
 * registration boundary and returns WAV bytes for the core model contract.
 */
export function makeKokoroTextToSpeechHandler(
  opts: AospKokoroTtsHandlerOptions = {},
): TextToSpeechHandler {
  let backendPromise: Promise<{
    backend: KokoroTtsBackend;
    config: KokoroEngineDiscoveryResult;
  }> | null = null;

  async function ensureBackend(): Promise<{
    backend: KokoroTtsBackend;
    config: KokoroEngineDiscoveryResult;
  }> {
    if (backendPromise) return backendPromise;
    const started = Date.now();
    const promise = Promise.resolve().then(() => {
      const config = opts.discover
        ? opts.discover()
        : resolveKokoroEngineConfig();
      if (!config) {
        throw new Error(
          "[aosp-local-inference] Kokoro TEXT_TO_SPEECH is not available: stage an ONNX Kokoro model plus at least one voice .bin under <state-dir>/local-inference/models/kokoro/.",
        );
      }
      if (config.runtimeKind !== "onnx" && !opts.runtime) {
        throw new Error(
          `[aosp-local-inference] Kokoro TEXT_TO_SPEECH discovered ${config.runtimeKind} artifacts, but the AOSP handler currently supports the CPU ONNX runtime path.`,
        );
      }
      const runtime =
        opts.runtime ??
        new KokoroOnnxRuntime({
          layout: config.layout,
          expectedSha256: process.env.ELIZA_KOKORO_MODEL_SHA256 ?? null,
          loadOrt: opts.loadOrt ?? loadAospKokoroOrt,
        });
      return {
        config,
        backend: new KokoroTtsBackend({
          layout: config.layout,
          runtime,
          defaultVoiceId: config.defaultVoiceId,
        }),
      };
    });
    promise
      .then(({ config }) => {
        logger.info(
          `[aosp-local-inference] Kokoro TEXT_TO_SPEECH backend ready in ${Date.now() - started}ms (${config.runtimeKind}, voice=${config.defaultVoiceId})`,
        );
      })
      .catch(() => {
        // The awaited handler path reports the actual startup error.
      });
    backendPromise = promise.catch((err) => {
      backendPromise = null;
      throw err;
    });
    return backendPromise;
  }

  return async (_runtime, params) => {
    const text = extractSpeechText(params).trim();
    if (!text) {
      throw new Error(
        "[aosp-local-inference] TEXT_TO_SPEECH requires non-empty text",
      );
    }

    const signal = extractSpeechSignal(params);
    const cancelSignal = { cancelled: Boolean(signal?.aborted) };
    const abort = () => {
      cancelSignal.cancelled = true;
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const started = Date.now();
      const { backend, config } = await ensureBackend();
      const backendReadyMs = Date.now() - started;
      const synthStarted = Date.now();
      const audio = await backend.synthesize({
        phrase: {
          id: 0,
          text,
          fromIndex: 0,
          toIndex: text.length,
          terminator: "punctuation",
        },
        preset: {
          voiceId: resolveStagedSpeechVoice(params, config),
          embedding: new Float32Array(0),
          bytes: new Uint8Array(0),
        },
        cancelSignal,
      });
      const synthMs = Date.now() - synthStarted;
      if (cancelSignal.cancelled) {
        throw new Error("[aosp-local-inference] TEXT_TO_SPEECH aborted");
      }
      const encodeStarted = Date.now();
      const wav = encodeWavPcm16(audio.pcm, audio.sampleRate);
      const encodeMs = Date.now() - encodeStarted;
      logger.info(
        `[aosp-local-inference] Kokoro TEXT_TO_SPEECH completed chars=${text.length} voice=${resolveStagedSpeechVoice(params, config)} backendReadyMs=${backendReadyMs} synthMs=${synthMs} encodeMs=${encodeMs} pcmSamples=${audio.pcm.length} wavBytes=${wav.byteLength}`,
      );
      return wav;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
}

export function prewarmKokoroTextToSpeechHandler(
  handler: TextToSpeechHandler,
): void {
  if (readBooleanEnv("ELIZA_KOKORO_PREWARM") !== true) return;

  const delayMs = readPositiveIntEnv("ELIZA_KOKORO_PREWARM_DELAY_MS", 5_000);
  const timeoutMs = readPositiveIntEnv(
    "ELIZA_KOKORO_PREWARM_TIMEOUT_MS",
    45_000,
  );
  const text =
    process.env.ELIZA_KOKORO_PREWARM_TEXT?.trim() || "Hello from Eliza.";

  setTimeout(() => {
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

type BunFfiModule = {
  dlopen: (
    file: string,
    symbols: Record<string, { args: readonly number[]; returns: number }>,
  ) => {
    symbols: Record<string, (...args: unknown[]) => unknown>;
    close: () => void;
  };
  FFIType: Record<string, number>;
  ptr: (value: ArrayBufferView) => bigint;
  read?: { ptr?: (value: ArrayBufferView, offset?: number) => bigint };
  CString?: (ptr: bigint) => string;
};

async function loadAospVoiceFfi(): Promise<BunFfiModule> {
  const ffiSpecifier = "bun" + ":ffi";
  const ffi = (await import(ffiSpecifier)) as unknown as BunFfiModule;
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
  return path.join(path.dirname(resolveLibllamaPath()), "libelizainference.so");
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
  const modelsDir = resolveBundledModelsDir();
  const assigned = readAssignedBundledModels(modelsDir);
  const manifest = readBundledModelManifest(modelsDir);
  const fallback = fallbackFindBundledModels(modelsDir);
  const chatModel = assigned.chat ?? manifest.chat ?? fallback.chat;
  if (!chatModel) {
    throw new Error(
      `[aosp-local-inference] TRANSCRIPTION requires an installed Eliza-1 chat bundle under ${modelsDir}`,
    );
  }
  const bundleRoot = resolveBundleRootFromModelPath(chatModel);
  if (!existsSync(path.join(bundleRoot, "asr"))) {
    throw new Error(
      `[aosp-local-inference] TRANSCRIPTION requires ASR assets under ${bundleRoot}/asr`,
    );
  }
  return bundleRoot;
}

function readFfiStringAndFree(
  ffi: BunFfiModule,
  symbols: Record<string, (...args: unknown[]) => unknown>,
  ptrBuffer: Buffer,
): string {
  const raw = ffi.read?.ptr?.(ptrBuffer, 0) ?? 0n;
  if (!raw || raw === 0n) return "(no diagnostic)";
  let text = "(unreadable diagnostic)";
  try {
    text =
      typeof ffi.CString === "function" ? ffi.CString(raw) : "(no CString)";
  } catch {}
  try {
    symbols.eliza_inference_free_string?.(raw);
  } catch {}
  return text;
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
): Promise<string> {
  assertNotAborted(signal);
  const libPath = resolveElizaInferenceLibPath();
  if (!existsSync(libPath)) {
    throw new Error(
      `[aosp-local-inference] libelizainference.so missing at ${libPath}`,
    );
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

export function makeAospTranscriptionHandler(): TranscriptionHandler {
  return async (_runtime, params) => {
    const { signal, ...audio } = extractAospTranscriptionAudio(params);
    return transcribeWithAospElizaInference(audio, signal);
  };
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

  // Wrap registerService transiently to capture the loader passed via the
  // (name, impl) overload that `registerAospLlamaLoader` uses. See the
  // helper's docblock for the why.
  console.log("[aosp-local-inference] calling registerAospLlamaLoader…");
  const { ok: registered, loader } =
    await callRegisterAndCaptureLoader(runtime);
  console.log(
    `[aosp-local-inference] registerAospLlamaLoader returned ok=${registered} loader=${loader ? "present" : "null"}`,
  );
  if (!registered) {
    console.error("[aosp-local-inference] adapter registration failed");
    logger.error(
      "[aosp-local-inference] AOSP llama loader registration failed; TEXT_* handlers NOT wired.",
    );
    return false;
  }
  if (!loader) {
    console.error("[aosp-local-inference] adapter ok but no loader captured");
    logger.error(
      "[aosp-local-inference] Loader registration reported success but the (name, impl) overload was not captured. The adapter may have changed its registerService call shape.",
    );
    return false;
  }

  const lifecycle = makeLoaderLifecycle(loader);
  // TEXT_EMBEDDING is wired unconditionally now that the adapter resets
  // the llama.cpp embeddings flag on both decode paths (chat + embed) —
  // the previous `ELIZA_AOSP_EMBEDDING=1` opt-in existed only because
  // the shared-context flag bled across calls and caused
  //   GGML_ASSERT((!batch_inp.token && batch_inp.embd) ||
  //               (batch_inp.token && !batch_inp.embd))
  // inside llama_decode, crashing the bun process mid-request. With the
  // explicit pre-decode `llama_set_embeddings` call in both `generate()`
  // and `embed()`, the assert can no longer fire from cross-mode bleed.
  const slots: Array<(typeof ModelType)[keyof typeof ModelType]> = [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
    ModelType.TEXT_EMBEDDING,
    ModelType.TEXT_TO_SPEECH,
    ModelType.TRANSCRIPTION,
  ];
  const kokoroTextToSpeechHandler = makeKokoroTextToSpeechHandler();
  for (const modelType of slots) {
    const handler =
      modelType === ModelType.TEXT_EMBEDDING
        ? makeEmbeddingHandler(loader, lifecycle)
        : modelType === ModelType.TEXT_TO_SPEECH
          ? kokoroTextToSpeechHandler
          : modelType === ModelType.TRANSCRIPTION
            ? makeAospTranscriptionHandler()
            : makeGenerateHandler(loader, lifecycle);
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
      makeCloudFallbackHandler(loader, lifecycle, modelType),
      `${PROVIDER}-cloud-fallback`,
      CLOUD_FALLBACK_PRIORITY,
    );
  }

  // Pre-warm the chat model so the first incoming chat request doesn't
  // pay the ~10 s `llama_model_load_from_file` + ~5 s
  // `llama_init_from_model` cost inside the request handler. The load
  // is best-effort: if the bundled chat file is missing we let the
  // request handler bubble up a clear error instead of crashing the
  // boot. ensureChatLoaded is also memoized at the lifecycle layer, so
  // calling it here doesn't conflict with the first real request.
  void lifecycle.ensureChatLoaded().catch((err) => {
    logger.warn(
      "[aosp-local-inference] Chat model pre-warm failed (will retry on first request): " +
        (err instanceof Error ? err.message : String(err)),
    );
  });
  prewarmKokoroTextToSpeechHandler(kokoroTextToSpeechHandler);

  console.log(
    `[aosp-local-inference] registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING / TEXT_TO_SPEECH / TRANSCRIPTION (priority ${LOCAL_INFERENCE_PRIORITY})`,
  );
  logger.info(
    `[aosp-local-inference] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING / TEXT_TO_SPEECH / TRANSCRIPTION at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
  registeredRuntimes.add(runtime);
  return true;
}
