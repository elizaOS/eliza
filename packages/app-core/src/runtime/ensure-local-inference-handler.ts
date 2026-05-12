/**
 * Registers the standalone llama.cpp engine as the runtime handler for
 * `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE`.
 *
 * Priority is 0 — same band as cloud and direct provider plugins. Tie-breaks
 * between local and cloud are owned by the routing-policy layer
 * (`router-handler.ts` + `routing-policy.ts`), not by this priority value:
 * the router sits at MAX_SAFE_INTEGER and consults the user's policy
 * (manual / cheapest / fastest / prefer-local / round-robin) on every call.
 *
 * Until the cuttlefish smoke landed this was -1 to "let cloud win by default,"
 * but that conflated routing-policy (a user preference) with handler
 * priority (a registration ordinal). The runtime's getModel() returns
 * undefined when no priority-0 handler is registered, which manifested as
 * "No handler found for delegate type: TEXT_SMALL" on AOSP builds where
 * the AOSP local inference loader is the only provider. Both cloud-only and
 * local-only deployments now have a registered priority-0 handler; the
 * router decides which one fires per request.
 *
 * Parallels `ensure-text-to-speech-handler.ts` — same shape, same guards.
 */

import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
  renderMessageHandlerStablePrefix,
  type TextEmbeddingParams,
  type TextToSpeechParams,
  type TranscriptionParams,
  type UUID,
} from "@elizaos/core";
import {
  type LocalInferenceLoader,
  resolveLocalInferenceLoadArgs,
} from "../services/local-inference/active-model";
import {
  autoAssignAtBoot,
  readEffectiveAssignments,
} from "../services/local-inference/assignments";
import {
  extractConversationId,
  extractPromptCacheKey,
  resolveLocalCacheKey,
} from "../services/local-inference/cache-bridge";
import { deviceBridge } from "../services/local-inference/device-bridge";
import { localInferenceEngine } from "../services/local-inference/engine";
import { handlerRegistry } from "../services/local-inference/handler-registry";
import { listInstalledModels } from "../services/local-inference/registry";
import { installRouterHandler } from "../services/local-inference/router-handler";
import type { AgentModelSlot } from "../services/local-inference/types";
import {
  decodeMonoPcm16Wav,
  type TranscriptionAudio,
} from "../services/local-inference/voice";
import { getRuntimeMode } from "./mode/runtime-mode";

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

/**
 * Embedding handler signature — accepts the same union the runtime hands
 * to TEXT_EMBEDDING calls (`TextEmbeddingParams | string | null`) and
 * returns the raw float vector.
 */
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
}

type LocalModelHandler =
  | GenerateTextHandler
  | EmbeddingHandler
  | TextToSpeechHandler
  | TranscriptionHandler;

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (modelType: string | number) => LocalModelHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: LocalModelHandler,
    provider: string,
    priority?: number,
  ) => void;
};

const LOCAL_INFERENCE_PROVIDER = "eliza-local-inference";
const DEVICE_BRIDGE_PROVIDER = "eliza-device-bridge";
const CAPACITOR_LLAMA_PROVIDER = "capacitor-llama";
const AOSP_LLAMA_PROVIDER = "eliza-aosp-llama";
const LOCAL_INFERENCE_HANDLER_INSTALLED = Symbol.for(
  "elizaos.local-inference.handlers-installed",
);
type RuntimeWithLocalInferenceFlag = RuntimeWithModelRegistration & {
  [LOCAL_INFERENCE_HANDLER_INSTALLED]?: boolean;
};
/**
 * Same band as cloud / direct provider plugins. Tie-breaks between
 * candidates live in `routing-policy.ts`, not in this number — the
 * router (registered at MAX_SAFE_INTEGER) consults the user's
 * per-slot policy on every dispatch.
 *
 * Was -1 historically, which made `runtime.getModel(TEXT_SMALL)` return
 * undefined when the AOSP local-inference loader was the only registered
 * provider. The smoke run failed with "No handler found for delegate
 * type: TEXT_SMALL"; bumping to 0 unblocks AOSP without changing
 * cloud-only deployments (cloud providers still register at 0 and the
 * routing-policy layer picks between them).
 */
const LOCAL_INFERENCE_PRIORITY = 0;

export function shouldRegisterLocalInferenceHandlers(mode: string): boolean {
  return mode === "local" || mode === "local-only";
}

function getLoader(runtime: IAgentRuntime): LocalInferenceLoader | null {
  const candidate = (
    runtime as { getService?: (name: string) => unknown }
  ).getService?.("localInferenceLoader");
  if (!candidate || typeof candidate !== "object") return null;
  const loader = candidate as Partial<LocalInferenceLoader>;
  if (
    typeof loader.loadModel === "function" &&
    typeof loader.unloadModel === "function"
  ) {
    return candidate as LocalInferenceLoader;
  }
  return null;
}

/**
 * Look up the model assigned to a given agent slot and ensure it's the
 * one loaded before generation runs. Loads lazily on first call; swaps
 * when a different slot's assignment fires with a different model.
 *
 * If no assignment is set for the slot, falls back to whatever is
 * currently loaded (keeps the old "one active model" behaviour).
 */
async function ensureAssignedModelLoaded(
  loader: LocalInferenceLoader | null,
  slot: AgentModelSlot,
): Promise<void> {
  const assignments = await readEffectiveAssignments();
  const assignedId = assignments[slot];
  if (!assignedId) return;

  // Desktop fast path: check the engine state directly.
  if (!loader && localInferenceEngine.currentModelPath()) {
    const installed = await listInstalledModels();
    const current = installed.find(
      (m) => m.path === localInferenceEngine.currentModelPath(),
    );
    if (current?.id === assignedId) return;
  }

  // Via loader: compare reported path against assignment.
  if (loader) {
    const currentPath = loader.currentModelPath();
    if (currentPath) {
      const installed = await listInstalledModels();
      const current = installed.find((m) => m.path === currentPath);
      if (current?.id === assignedId) return;
    }
  }

  const installed = await listInstalledModels();
  const target = installed.find((m) => m.id === assignedId);
  if (!target) {
    throw new Error(
      `[local-inference] Slot ${slot} assigned to ${assignedId}, but that model is not installed.`,
    );
  }

  if (loader) {
    await loader.unloadModel();
    await loader.loadModel(await resolveLocalInferenceLoadArgs(target));
  } else {
    await localInferenceEngine.load(target.path);
  }
}

/**
 * Project a `GenerateTextParams` onto the engine's `GenerateArgs`, threading
 * the structure-forcing extensions (`prefill`, `responseSkeleton`, `grammar`,
 * `streamStructured`) and wiring `onStreamChunk` to the engine's per-token
 * `onTextChunk`. Cloud adapters ignore these fields; the local engine honours
 * them (the forced-span / prefill / grammar path is local-model-only).
 */
function engineGenerateArgsFromParams(
  params: GenerateTextParams,
  cacheKey: string | undefined,
): {
  prompt: string;
  stopSequences?: string[];
  cacheKey?: string;
  signal?: AbortSignal;
  prefill?: string;
  responseSkeleton?: GenerateTextParams["responseSkeleton"];
  grammar?: string;
  streamStructured?: boolean;
  onTextChunk?: (chunk: string) => void | Promise<void>;
  voiceOutput?: "user-visible" | "internal";
} {
  const streamStructured = params.streamStructured === true;
  // Surface per-token chunks to the caller. The runtime passes the agent
  // reply path's `onStreamChunk` here when it wants the LLM→TTS handoff —
  // previously dropped at this layer. Only wire it when the caller asked
  // for streaming (`stream` or `streamStructured`) so non-streaming callers
  // don't pay the chunk-callback overhead.
  const onTextChunk =
    (params.stream === true || streamStructured) &&
    typeof params.onStreamChunk === "function"
      ? (chunk: string) => params.onStreamChunk?.(chunk)
      : undefined;
  return {
    prompt: params.prompt ?? "",
    stopSequences: params.stopSequences,
    cacheKey,
    signal: params.signal,
    prefill: params.prefill,
    responseSkeleton: params.responseSkeleton,
    grammar: params.grammar,
    streamStructured: streamStructured || undefined,
    onTextChunk,
    voiceOutput:
      params.voiceOutput ??
      (typeof params.onStreamChunk === "function" ? "user-visible" : undefined),
  };
}

function makeHandler(slot: AgentModelSlot): GenerateTextHandler {
  return async (runtime, params) => {
    const loader = getLoader(runtime);

    // Lazy-load the assigned model for this slot, if any. Swaps are
    // expensive; the user is expected to assign a small number of models.
    await ensureAssignedModelLoaded(loader, slot);

    // Resolve the strongest cache key the runtime can give us. Order of
    // precedence (see `resolveLocalCacheKey`):
    //   1. Conversation id   — survives any prompt drift
    //   2. Stable-prefix hash — survives unstable-tail timestamps
    //   3. Provider plan hashes — back-compat
    const providerOptions = (params as { providerOptions?: unknown })
      .providerOptions;
    const conversationId = extractConversationId(providerOptions);
    const cacheKey =
      resolveLocalCacheKey(providerOptions) ??
      extractPromptCacheKey(providerOptions) ??
      undefined;
    const engineArgs = engineGenerateArgsFromParams(params, cacheKey);

    // Prefer a runtime-registered loader that implements `generate` — that's
    // the mobile / device-bridge path. On desktop we fall back to the
    // standalone engine.
    if (loader?.generate) {
      return loader.generate(engineArgs);
    }
    if (!(await localInferenceEngine.available())) {
      throw new Error(
        `[local-inference] No llama.cpp binding available for ${slot} request`,
      );
    }
    if (!localInferenceEngine.hasLoadedModel()) {
      throw new Error(
        `[local-inference] No local model is active. Assign a model to ${slot} or activate one in Settings → Local models.`,
      );
    }

    // Long-lived conversation? Open / reuse a registry handle so this
    // turn lands on the same slot every time, regardless of prompt
    // hash drift. The handle API additionally returns Anthropic-shape
    // usage telemetry, which we surface at INFO once per generation.
    if (conversationId) {
      const modelId =
        localInferenceEngine.currentModelPath() ?? "default-local-model";
      const handle =
        localInferenceEngine.conversation(conversationId, modelId) ??
        localInferenceEngine.openConversation({
          conversationId,
          modelId,
        });
      const { cacheKey: _drop, ...convArgs } = engineArgs;
      const result = await localInferenceEngine.generateInConversation(
        handle,
        convArgs,
      );
      // Per-generation usage log. Match the Anthropic plugin's
      // observability surface so cloud and local share the same
      // mental model. Cache hit rate is reported when input_tokens > 0.
      const u = result.usage;
      const hitRate =
        u.cache_hit_rate !== undefined
          ? `${Math.round(u.cache_hit_rate * 100)}%`
          : "n/a";
      const dflashRate =
        u.dflash_acceptance_rate !== undefined
          ? ` dflash=${Math.round(u.dflash_acceptance_rate * 100)}%`
          : "";
      logger.info(
        `[local-inference] usage conv=${conversationId} slot=${result.slotId} in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens} cache_create=${u.cache_creation_input_tokens} hit=${hitRate}${dflashRate}`,
      );
      // Auto-tune signal — emits a one-line warn if the high-water mark
      // outgrew the configured slot count this turn. Cheap to call,
      // and the warning is what the operator needs to see.
      localInferenceEngine.warnIfParallelTooLow({ warn: logger.warn });
      return result.text;
    }

    // No conversation context: fall through to the existing hash-based
    // slot allocation. Doesn't break any caller that wasn't aware of
    // conversation handles.
    return localInferenceEngine.generate(engineArgs);
  };
}

/**
 * Normalize the runtime's TEXT_EMBEDDING input shape — `params` may be the
 * structured `TextEmbeddingParams` (when called from a typed plugin), a
 * raw string (when called from action runners), or `null` (an internal
 * warmup probe used to size the shipped embedding vector).
 */
function extractEmbeddingText(
  params: TextEmbeddingParams | string | null,
): string {
  if (params === null) return "";
  if (typeof params === "string") return params;
  return params.text;
}

/**
 * Build the TEXT_EMBEDDING handler. Mirrors `makeHandler` for generate:
 * routes through the loader's `embed` if available, otherwise throws so
 * the runtime falls back to a non-local provider rather than serving a
 * silent zero-vector (Commandment 8: don't hide broken pipelines).
 */
function makeEmbeddingHandler(): EmbeddingHandler {
  return async (runtime, params) => {
    const loader = getLoader(runtime);
    if (!loader?.embed) {
      throw new Error(
        "[local-inference] Active loader does not implement embed; falling through to next provider",
      );
    }
    // Embeddings in this runtime are not slot-aware — there's a single
    // active model. Make sure the user's TEXT_EMBEDDING assignment, if
    // any, is loaded before we hit the loader.
    await ensureAssignedModelLoaded(loader, "TEXT_EMBEDDING");
    const text = extractEmbeddingText(params);
    const result = await loader.embed({ input: text });
    return result.embedding;
  };
}

/**
 * TEXT_EMBEDDING handler for the desktop/server `LocalInferenceEngine`
 * path: the engine has no `embed()` on the `LocalInferenceLoader` service
 * surface (that's only the AOSP / device-bridge loaders), but when an
 * Eliza-1 bundle is active it serves embeddings through the bundle's
 * local embedding model — pooled text on `0_8b`, the dedicated
 * `embedding/` GGUF on larger tiers — via a lazily-started embedding
 * `llama-server` sidecar. Throws (→ runtime falls through to the
 * operator-configured provider) when no Eliza-1 bundle is loaded; no
 * zero-vector (Commandment 8).
 */
function makeEngineEmbeddingHandler(): EmbeddingHandler {
  return async (_runtime, params) => {
    if (!localInferenceEngine.canEmbed()) {
      throw new Error(
        "[local-inference] No Eliza-1 bundle active; the local embedding model is part of an Eliza-1 bundle — falling through to next provider",
      );
    }
    const text = extractEmbeddingText(params);
    const [vec] = await localInferenceEngine.embed(text);
    if (!vec) {
      throw new Error("[local-inference] embed() returned no vector");
    }
    return vec;
  };
}

function extractSpeechText(params: TextToSpeechParams | string): string {
  if (typeof params === "string") return params;
  if (params && typeof params.text === "string") return params.text;
  throw new Error(
    "[local-inference] TEXT_TO_SPEECH requires a string or { text } input",
  );
}

function makeTextToSpeechHandler(): TextToSpeechHandler {
  return async (_runtime, params) => {
    const text = extractSpeechText(params);
    if (text.length === 0) {
      throw new Error(
        "[local-inference] TEXT_TO_SPEECH text must be non-empty",
      );
    }
    // Do not filter singing, emotion tags, or lyrical phrasing here. The
    // local voice bundle advertises its expressive capability in the
    // manifest; runtime safety policy lives above this model adapter.
    return localInferenceEngine.synthesizeSpeech(text);
  };
}

function toUint8Array(value: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function extractTranscriptionAudio(
  params: TranscriptionParams | Buffer | string | LocalTranscriptionParams,
): TranscriptionAudio {
  if (typeof params === "string") {
    throw new Error(
      "[local-inference] TRANSCRIPTION via the local voice runtime requires PCM/WAV bytes; URL/path strings are not fetched by this provider",
    );
  }
  if (params instanceof Uint8Array || params instanceof ArrayBuffer) {
    return decodeMonoPcm16Wav(toUint8Array(params));
  }
  if (!params || typeof params !== "object") {
    throw new Error(
      "[local-inference] TRANSCRIPTION requires PCM/WAV bytes or { pcm, sampleRateHz }",
    );
  }
  if ("audioUrl" in params && typeof params.audioUrl === "string") {
    throw new Error(
      "[local-inference] TRANSCRIPTION audioUrl is not fetched by the local voice runtime; pass mono PCM16 WAV bytes or { pcm, sampleRateHz }",
    );
  }
  if ("pcm" in params && params.pcm instanceof Float32Array) {
    const sampleRate =
      ("sampleRateHz" in params ? params.sampleRateHz : undefined) ??
      ("sampleRate" in params ? params.sampleRate : undefined);
    if (typeof sampleRate !== "number" || sampleRate <= 0) {
      throw new Error(
        "[local-inference] TRANSCRIPTION { pcm } requires a positive sampleRateHz",
      );
    }
    return { pcm: params.pcm, sampleRate };
  }
  if (
    "audio" in params &&
    (params.audio instanceof Uint8Array || params.audio instanceof ArrayBuffer)
  ) {
    return decodeMonoPcm16Wav(toUint8Array(params.audio));
  }
  throw new Error(
    "[local-inference] TRANSCRIPTION requires mono PCM16 WAV bytes or { pcm, sampleRateHz } for the local voice runtime",
  );
}

function makeTranscriptionHandler(): TranscriptionHandler {
  return async (_runtime, params) => {
    const audio = extractTranscriptionAudio(params);
    return localInferenceEngine.transcribePcm(audio);
  };
}

/**
 * Register the device-bridge loader on the runtime. Accepts load/generate
 * calls whether or not a mobile device is currently connected — parked
 * calls resolve on reconnect (up to a timeout). Cheaper than waiting for
 * the first device register to register the service: ordering is already
 * handled inside `DeviceBridge.generate`.
 */
function registerDeviceBridgeLoader(runtime: AgentRuntime): void {
  const withRegistration = runtime as AgentRuntime & {
    registerService?: (name: string, impl: unknown) => unknown;
  };
  if (typeof withRegistration.registerService !== "function") return;
  const loader: LocalInferenceLoader = {
    loadModel: (args) => deviceBridge.loadModel(args),
    unloadModel: () => deviceBridge.unloadModel(),
    currentModelPath: () => deviceBridge.currentModelPath(),
    generate: (args) => deviceBridge.generate(args),
    embed: (args) => deviceBridge.embed(args),
  };
  withRegistration.registerService("localInferenceLoader", loader);
}

/**
 * AOSP-only path: load `libllama.so` directly into the bun process via
 * `bun:ffi`. The adapter no-ops at runtime when `ELIZA_LOCAL_LLAMA !== "1"`,
 * so the dynamic import below is safe on every platform; we only attempt
 * registration when the user explicitly opted in.
 *
 * The `try`/`catch` is justified because the AOSP build can ship the .so on
 * one ABI but be invoked on another (e.g. cuttlefish_x86_64 reporting both
 * x86_64 and arm64-v8a). When `ELIZA_LOCAL_LLAMA=1` is set but registration
 * fails, the adapter logs at `error` level — we must NOT silently fall
 * through to the device-bridge or stock engine: the operator opted in and
 * deserves the failure surfaced clearly.
 */
async function tryRegisterAospLlamaLoader(
  runtime: AgentRuntime,
): Promise<boolean> {
  if (process.env.ELIZA_LOCAL_LLAMA?.trim() !== "1") return false;
  try {
    const mod = (await import(
      "@elizaos/plugin-aosp-local-inference"
    )) as typeof import("@elizaos/plugin-aosp-local-inference") & {
      registerAospLlamaLoader?: (r: AgentRuntime) => Promise<boolean> | boolean;
    };
    if (typeof mod.registerAospLlamaLoader !== "function") {
      logger.error(
        "[local-inference] AOSP llama adapter import resolved but missing registerAospLlamaLoader export",
      );
      return false;
    }
    const result = await mod.registerAospLlamaLoader(runtime);
    return Boolean(result);
  } catch (err) {
    logger.error(
      "[local-inference] AOSP llama adapter unavailable while ELIZA_LOCAL_LLAMA=1:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

async function tryRegisterCapacitorLoader(
  runtime: AgentRuntime,
): Promise<boolean> {
  // Only meaningful under Capacitor (iOS/Android). Dynamic import so web /
  // desktop bundlers don't choke on the native plugin metadata.
  const cap = (globalThis as Record<string, unknown>).Capacitor as
    | { isNativePlatform?: () => boolean }
    | undefined;
  if (!cap?.isNativePlatform?.()) return false;
  try {
    const { registerCapacitorLlamaLoader } = await import(
      "@elizaos/capacitor-llama"
    );
    const capacitorRuntime: Parameters<typeof registerCapacitorLlamaLoader>[0] =
      Object.create(runtime);
    registerCapacitorLlamaLoader(capacitorRuntime);
    logger.info(
      "[local-inference] Registered capacitor-llama loader for mobile on-device inference",
    );
    return true;
  } catch (err) {
    logger.debug(
      "[local-inference] capacitor-llama not available:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return false;
}

/**
 * Synthetic conversation id used to keep the Stage-1 stable prefix
 * (system prompt + tool/action schema block + stable provider blocks)
 * resident on a deterministic slot before any real conversation lands.
 * `deriveSlotId("conv:__system_prefix__", parallel)` is stable, so this
 * always warms the same slot; per-room conversations get their own slot
 * via `conv:<roomId>` and inherit the radix-shared prefix tokens.
 */
const SYSTEM_PREFIX_CONVERSATION_ID = "__system_prefix__";

/**
 * Render the Stage-1 stable prefix for `roomId` and KV-prefill the
 * local-inference slot that conversation pins to. Wire this from the
 * voice turn controller (W9) on `speech-start` / voice-session-open so
 * the response-handler prompt is hot before STT finishes — items I1/C1.
 *
 * Best-effort end to end: returns false (no throw) when there's no
 * loaded local model, the active backend can't pre-warm (node-llama-cpp
 * pins by cache key already), or rendering/pre-warm fails. A miss just
 * means the real request cold-prefills.
 */
export async function prewarmResponseHandler(
  runtime: IAgentRuntime,
  roomId: UUID,
): Promise<boolean> {
  if (!localInferenceEngine.hasLoadedModel()) return false;
  if (localInferenceEngine.activeBackendId() !== "llama-server") return false;
  try {
    const prefix = await renderMessageHandlerStablePrefix(runtime, roomId);
    if (!prefix) return false;
    return await localInferenceEngine.prewarmConversation(
      String(roomId),
      prefix,
    );
  } catch (err) {
    logger.debug(
      "[local-inference] prewarmResponseHandler failed (best-effort):",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Warm the Stage-1 stable prefix onto the deterministic
 * `conv:__system_prefix__` slot at model-load / boot time, before any
 * user message — item I3 (warm-on-load). The room id is irrelevant for
 * the stable prefix (it carries no per-room state), so a fixed synthetic
 * id is fine. No-op when no local model is loaded or the backend can't
 * pre-warm. Best-effort: failures are logged at debug and swallowed.
 */
export async function prewarmSystemPrefix(
  runtime: IAgentRuntime,
): Promise<boolean> {
  if (!localInferenceEngine.hasLoadedModel()) return false;
  if (localInferenceEngine.activeBackendId() !== "llama-server") return false;
  try {
    const fixedRoomId = (runtime.agentId ??
      SYSTEM_PREFIX_CONVERSATION_ID) as UUID;
    const prefix = await renderMessageHandlerStablePrefix(runtime, fixedRoomId);
    if (!prefix) return false;
    return await localInferenceEngine.prewarmConversation(
      SYSTEM_PREFIX_CONVERSATION_ID,
      prefix,
    );
  } catch (err) {
    logger.debug(
      "[local-inference] prewarmSystemPrefix failed (best-effort):",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

export async function ensureLocalInferenceHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const runtimeMode = getRuntimeMode();
  if (!shouldRegisterLocalInferenceHandlers(runtimeMode)) {
    logger.info(
      `[local-inference] Runtime mode is ${runtimeMode}; skipping local model handler registration`,
    );
    return;
  }

  const runtimeWithRegistration = runtime as RuntimeWithLocalInferenceFlag;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    return;
  }
  if (runtimeWithRegistration[LOCAL_INFERENCE_HANDLER_INSTALLED]) {
    logger.debug(
      "[local-inference] Local model handlers already registered on this runtime; skipping duplicate registration",
    );
    return;
  }

  // Install the side-registry interception as early as possible so it
  // captures every subsequent `registerModel` call — including our own
  // handlers below, plus anything else that registers during the rest of
  // boot. Idempotent per-runtime.
  handlerRegistry.installOn(runtime);

  // Loader precedence:
  //   1. AOSP native FFI loader when running inside the AOSP agent process
  //      itself (ELIZA_LOCAL_LLAMA=1). This is the canonical AOSP path —
  //      libllama.so is dlopen'd directly, no IPC.
  //   2. Capacitor native adapter when running on a mobile device with the
  //      Capacitor APK shell.
  //   3. Device-bridge (WebSocket to a paired phone) when explicitly
  //      opted in via ELIZA_DEVICE_BRIDGE_ENABLED=1.
  //   4. Standalone node-llama-cpp engine for desktop / server.
  //
  // All four satisfy the same `localInferenceLoader` service contract.
  // A later registration overrides an earlier one, so we register in
  // LOWEST-priority order first; the AOSP loader runs last so it wins on
  // AOSP builds. Each `try*Loader` is idempotent and gated on its own env
  // signal, so they're safe to chain.
  const aospRegistered = await tryRegisterAospLlamaLoader(runtime);
  const capacitorRegistered =
    !aospRegistered && (await tryRegisterCapacitorLoader(runtime));
  const deviceBridgeEnabled =
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
  if (!aospRegistered && !capacitorRegistered && deviceBridgeEnabled) {
    registerDeviceBridgeLoader(runtime);
    logger.info(
      "[local-inference] Registered device-bridge loader; inference routes to paired mobile device when connected",
    );
  }

  // Pre-flight: if no backend is available, skip handler registration
  // entirely so we don't advertise a handler that will throw. The device
  // bridge is always "available" in the sense that it parks calls until a
  // device connects, so if it is enabled we always register handlers.
  if (
    !aospRegistered &&
    !capacitorRegistered &&
    !deviceBridgeEnabled &&
    !(await localInferenceEngine.available())
  ) {
    logger.debug(
      "[local-inference] No local inference backend available; skipping model registration",
    );
    return;
  }

  // First-light convenience: when exactly one model is installed and no
  // slot assignments exist, auto-fill TEXT_SMALL/TEXT_LARGE so the user
  // lands in chat without opening Settings. The downloader handles the
  // post-install case; this catches the user who pre-staged a model
  // (external scan, prior install) and is now booting fresh.
  try {
    const installed = await listInstalledModels();
    const filled = await autoAssignAtBoot(installed);
    if (filled) {
      logger.info(
        `[local-inference] Auto-assigned single installed model to empty slots: ${JSON.stringify(filled)}`,
      );
    }
  } catch (err) {
    logger.warn(
      "[local-inference] autoAssignAtBoot failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const provider = aospRegistered
    ? AOSP_LLAMA_PROVIDER
    : capacitorRegistered
      ? CAPACITOR_LLAMA_PROVIDER
      : deviceBridgeEnabled
        ? DEVICE_BRIDGE_PROVIDER
        : LOCAL_INFERENCE_PROVIDER;

  const slots: Array<
    [(typeof ModelType)[keyof typeof ModelType], AgentModelSlot]
  > = [
    [ModelType.TEXT_SMALL, "TEXT_SMALL"],
    [ModelType.TEXT_LARGE, "TEXT_LARGE"],
  ];
  for (const [modelType, slot] of slots) {
    try {
      runtimeWithRegistration.registerModel(
        modelType,
        makeHandler(slot),
        provider,
        LOCAL_INFERENCE_PRIORITY,
      );
    } catch (err) {
      logger.warn(
        "[local-inference] Could not register ModelType",
        modelType,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Register TEXT_EMBEDDING separately — the runtime contract returns
  // `number[]` instead of `string`, so it can't share `makeHandler`.
  //   - AOSP / device-bridge loaders expose `embed()` on the
  //     `localInferenceLoader` service → route through that.
  //   - The desktop/server `LocalInferenceEngine` path has no loader
  //     `embed()`, but when an Eliza-1 bundle is loaded it serves
  //     embeddings through the bundle's local embedding model (pooled text
  //     on `0_8b`, the dedicated `embedding/` GGUF on larger tiers) via a
  //     lazily-started embedding `llama-server` sidecar.
  // In neither case do we register a handler that would serve a silent
  // zero-vector — both throw when there's nothing real to call, so the
  // runtime falls through to the operator-configured provider
  // (Commandment 8 / Commandment 10: the bundle's embedding model now has
  // a real runtime caller).
  const loaderForEmbed = (
    runtime as { getService?: (name: string) => unknown }
  ).getService?.("localInferenceLoader") as
    | { embed?: unknown }
    | null
    | undefined;
  const embeddingHandler =
    loaderForEmbed && typeof loaderForEmbed.embed === "function"
      ? makeEmbeddingHandler()
      : provider === LOCAL_INFERENCE_PROVIDER
        ? makeEngineEmbeddingHandler()
        : null;
  if (embeddingHandler) {
    try {
      runtimeWithRegistration.registerModel(
        ModelType.TEXT_EMBEDDING,
        embeddingHandler,
        provider,
        LOCAL_INFERENCE_PRIORITY,
      );
      logger.info(
        `[local-inference] Registered ${provider} embedding handler for TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`,
      );
    } catch (err) {
      logger.warn(
        "[local-inference] Could not register TEXT_EMBEDDING handler",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    runtimeWithRegistration.registerModel(
      ModelType.TEXT_TO_SPEECH,
      makeTextToSpeechHandler(),
      provider,
      LOCAL_INFERENCE_PRIORITY,
    );
    // TRANSCRIPTION is registered default-on at the local-inference floor
    // priority (0). It is the last-resort handler: any cloud / other-plugin
    // TRANSCRIPTION handler registers above 0 and wins. When the handler
    // does run, it drives the streaming ASR adapter chain (fused
    // Qwen3-ASR via libelizainference → whisper.cpp interim →
    // AsrUnavailableError) via the engine's armed voice bridge — see
    // makeTranscriptionHandler / EngineVoiceBridge.createStreamingTranscriber.
    // (The old ELIZA_LOCAL_TRANSCRIPTION env gate is removed — voice is a
    // first-class Eliza-1 surface, not opt-in.)
    runtimeWithRegistration.registerModel(
      ModelType.TRANSCRIPTION,
      makeTranscriptionHandler(),
      provider,
      LOCAL_INFERENCE_PRIORITY,
    );
    logger.info(
      `[local-inference] Registered ${provider} voice handlers for TEXT_TO_SPEECH / TRANSCRIPTION at priority ${LOCAL_INFERENCE_PRIORITY}`,
    );
  } catch (err) {
    logger.warn(
      "[local-inference] Could not register local voice handlers",
      err instanceof Error ? err.message : String(err),
    );
  }

  logger.info(
    `[local-inference] Registered ${provider} llama.cpp handler for TEXT_SMALL / TEXT_LARGE at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );

  // Install the top-priority router AFTER everything else has registered.
  // The router sits at Number.MAX_SAFE_INTEGER so the runtime dispatches
  // to it first; at dispatch time it picks a real provider via
  // `routing-policy` and calls that handler directly.
  installRouterHandler(runtime);
  logger.info(
    "[local-inference] Installed top-priority router for cross-provider routing",
  );
  runtimeWithRegistration[LOCAL_INFERENCE_HANDLER_INSTALLED] = true;

  // Warm-on-load (item I3): if a local model is already resident, KV-prefill
  // the Stage-1 stable prefix onto the deterministic system-prefix slot so
  // the system prompt + tool schema is hot before the first user turn.
  // Fire-and-forget — pre-warm is best-effort and must never block boot.
  void prewarmSystemPrefix(runtime).catch(() => {
    // Logged inside prewarmSystemPrefix at debug; nothing more to do here.
  });
}
