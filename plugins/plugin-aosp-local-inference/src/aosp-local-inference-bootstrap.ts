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
} from "@elizaos/core";
import { registerAospLlamaLoader } from "./aosp-llama-adapter.js";

const SERVICE_NAME = "localInferenceLoader";
const PROVIDER = "eliza-aosp-llama";
const registeredRuntimes = new WeakSet<AgentRuntime>();

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
  loadModel(args: { modelPath: string }): Promise<void>;
  unloadModel(): Promise<void>;
  currentModelPath(): string | null;
  generate(args: {
    prompt: string;
    stopSequences?: string[];
    maxTokens?: number;
    temperature?: number;
  }): Promise<string>;
  embed(args: { input: string }): Promise<{
    embedding: number[];
    tokens: number;
  }>;
}

type GenerateTextHandler = (
  runtime: IAgentRuntime,
  params: GenerateTextParams,
) => Promise<string>;

type EmbeddingHandler = (
  runtime: IAgentRuntime,
  params: TextEmbeddingParams | string | null,
) => Promise<number[]>;

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (
    modelType: string | number,
  ) => GenerateTextHandler | EmbeddingHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: GenerateTextHandler | EmbeddingHandler,
    provider: string,
    priority?: number,
  ) => void;
};

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

const AOSP_RECOMMENDED_MODELS: Record<"chat" | "embedding", AospRecommendedModel> = {
  chat: {
    id: "llama-3.2-1b",
    hfRepo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    ggufFile: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    expectedSizeBytes: 807_694_464,
  },
  embedding: {
    id: "bge-small-en-v1.5",
    hfRepo: "ChristianAzinn/bge-small-en-v1.5-gguf",
    ggufFile: "bge-small-en-v1.5.Q4_K_M.gguf",
    expectedSizeBytes: 24_808_576,
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
  for (const name of readdirSync(modelsDir)) {
    if (!name.endsWith(".gguf")) continue;
    const abs = path.join(modelsDir, name);
    const lower = name.toLowerCase();
    // Embedding match runs first so models like "bge-..." (no "instruct"
    // marker) don't get mistakenly classified as chat by the broader
    // "instruct" rule below.
    if (
      !embedding &&
      (lower.includes("bge") ||
        lower.includes("embed") ||
        lower.includes("nomic") ||
        lower.includes("minilm"))
    ) {
      embedding = abs;
    } else if (
      !chat &&
      (lower.includes("llama") ||
        lower.includes("smollm") ||
        lower.includes("qwen") ||
        lower.includes("instruct"))
    ) {
      chat = abs;
    }
  }
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
  let resolved = readBundledModelManifest(modelsDir);
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
      logger.info(
        `[aosp-local-inference] Loading bundled ${role} model: ${path.basename(target)}`,
      );
      await loader.loadModel({ modelPath: target });
      currentRole = role;
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

function makeGenerateHandler(
  loader: AospLoader,
  lifecycle: ReturnType<typeof makeLoaderLifecycle>,
): GenerateTextHandler {
  return async (_runtime, params) => {
    await lifecycle.ensureChatLoaded();
    const args: Parameters<AospLoader["generate"]>[0] = {
      prompt: params.prompt ?? "",
    };
    if (params.stopSequences !== undefined) {
      args.stopSequences = params.stopSequences;
    }
    return loader.generate(args);
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
  return async (_runtime, params) => {
    await lifecycle.ensureEmbeddingLoaded();
    const text = extractEmbeddingText(params);
    const result = await loader.embed({ input: text });
    return result.embedding;
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
  ];
  for (const modelType of slots) {
    const handler =
      modelType === ModelType.TEXT_EMBEDDING
        ? makeEmbeddingHandler(loader, lifecycle)
        : makeGenerateHandler(loader, lifecycle);
    runtimeWithRegistration.registerModel(
      modelType,
      handler,
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
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

  console.log(
    `[aosp-local-inference] registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING (priority ${LOCAL_INFERENCE_PRIORITY})`,
  );
  logger.info(
    `[aosp-local-inference] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
  registeredRuntimes.add(runtime);
  return true;
}
