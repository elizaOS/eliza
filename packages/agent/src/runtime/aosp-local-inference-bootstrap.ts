/**
 * AOSP-only local-inference handler bootstrap for the mobile agent bundle.
 *
 * Background: the upstream `startEliza()` in `runtime/eliza.ts` does not call
 * any local-inference wiring — that lives in the `@elizaos/app-core`
 * runtime wrapper (`ensure-local-inference-handler.ts`), which the mobile
 * agent bundle does NOT import. As a result, on AOSP the runtime boots
 * with `MILADY_LOCAL_LLAMA=1` set but no TEXT_SMALL / TEXT_LARGE /
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
 * Activation: only fires when `MILADY_LOCAL_LLAMA === "1"`, which is
 * the AOSP build flag set by `MiladyAgentService.java` before
 * `Runtime.exec`'ing the bun process. On every other build the call is
 * a logged no-op.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
  type TextEmbeddingParams,
} from "@elizaos/core";
import { registerAospLlamaLoader } from "./aosp-llama-adapter.js";

const SERVICE_NAME = "localInferenceLoader";
const PROVIDER = "milady-aosp-llama";

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
    ok = await registerAospLlamaLoader(
      runtime as unknown as Parameters<typeof registerAospLlamaLoader>[0],
    );
  } finally {
    target.registerService = originalRegisterService;
  }
  return { ok, loader: captured };
}

/**
 * Resolve the bundled chat / embedding GGUF paths shipped under
 * `$MILADY_STATE_DIR/local-inference/models/`. Both files are staged by
 * the AOSP build (`scripts/miladyos/stage-default-models.mjs`) and
 * extracted by `MiladyAgentService.extractAssetsIfNeeded` before bun
 * starts. We pick the role from the sibling `manifest.json` so a future
 * model swap doesn't need a code change.
 */
interface BundledModelManifestEntry {
  // The build-time staging script (`scripts/miladyos/stage-default-models.mjs`)
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

function resolveStateDir(): string {
  const explicit = process.env.MILADY_STATE_DIR ?? process.env.ELIZA_STATE_DIR;
  if (explicit?.trim()) return explicit;
  // On AOSP we expect MILADY_STATE_DIR to be set by MiladyAgentService.
  // Fall back to $HOME/.milady so dev / non-Android exercise paths still
  // resolve.
  const home = process.env.HOME ?? process.cwd();
  return path.join(home, ".milady");
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
    if (!chat && (lower.includes("smollm") || lower.includes("instruct"))) {
      chat = abs;
    } else if (
      !embedding &&
      (lower.includes("bge") || lower.includes("embed"))
    ) {
      embedding = abs;
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
    const target = role === "chat" ? resolved.chat : resolved.embedding;
    if (!target) {
      throw new Error(
        `[aosp-local-inference] No bundled ${role} model found under ${modelsDir}. Stage one via scripts/miladyos/stage-default-models.mjs and rebuild the APK.`,
      );
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
    return loader.generate({
      prompt: params.prompt,
      stopSequences: params.stopSequences,
    });
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
 * failure). All failures are logged at `error` because `MILADY_LOCAL_LLAMA=1`
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
  if (process.env.MILADY_LOCAL_LLAMA?.trim() !== "1") {
    console.log(
      "[aosp-local-inference] MILADY_LOCAL_LLAMA != '1', returning early",
    );
    return false;
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
  const slots: Array<(typeof ModelType)[keyof typeof ModelType]> = [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
  ];
  for (const modelType of slots) {
    runtimeWithRegistration.registerModel(
      modelType,
      makeGenerateHandler(loader, lifecycle),
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
    );
  }

  // TEXT_EMBEDDING wiring is gated. The AOSP llama adapter's embed path
  // currently triggers a native llama.cpp assert
  // (`GGML_ASSERT((!batch_inp.token && batch_inp.embd) ||
  // (batch_inp.token && !batch_inp.embd)) failed`) inside `llama_decode`
  // after `set_embeddings(1)` — which crashes the entire bun process
  // mid-request and breaks every subsequent chat. Until the C-side fix
  // lands, register the embedding handler ONLY when explicitly opted in
  // via `MILADY_AOSP_EMBEDDING=1`. With this off, the runtime falls back
  // to its existing "no embedding handler" graceful skip path
  // (`[API:CHAT-AUGMENTATION] Knowledge augmentation skipped after
  // retrieval failure`), which is non-fatal — the chat still works.
  if (process.env.MILADY_AOSP_EMBEDDING?.trim() === "1") {
    runtimeWithRegistration.registerModel(
      ModelType.TEXT_EMBEDDING,
      makeEmbeddingHandler(loader, lifecycle),
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
    );
    logger.info(
      "[aosp-local-inference] TEXT_EMBEDDING handler registered (MILADY_AOSP_EMBEDDING=1)",
    );
  } else {
    logger.info(
      "[aosp-local-inference] TEXT_EMBEDDING handler NOT registered — set MILADY_AOSP_EMBEDDING=1 once the llama_decode batch_inp assert is fixed in the native shim.",
    );
  }

  console.log(
    `[aosp-local-inference] registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING (priority ${LOCAL_INFERENCE_PRIORITY})`,
  );
  logger.info(
    `[aosp-local-inference] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
  return true;
}
