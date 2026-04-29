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
  getService: (name: string) => unknown;
};

function getRegisteredLoader(runtime: AgentRuntime): AospLoader | null {
  const candidate = (
    runtime as { getService?: (name: string) => unknown }
  ).getService?.(SERVICE_NAME);
  if (!candidate || typeof candidate !== "object") return null;
  const loader = candidate as Partial<AospLoader>;
  if (
    typeof loader.loadModel === "function" &&
    typeof loader.unloadModel === "function" &&
    typeof loader.generate === "function" &&
    typeof loader.embed === "function" &&
    typeof loader.currentModelPath === "function"
  ) {
    return candidate as AospLoader;
  }
  return null;
}

function makeGenerateHandler(loader: AospLoader): GenerateTextHandler {
  return async (_runtime, params) => {
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

function makeEmbeddingHandler(loader: AospLoader): EmbeddingHandler {
  return async (_runtime, params) => {
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
  if (process.env.MILADY_LOCAL_LLAMA?.trim() !== "1") return false;

  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
    logger.error(
      "[aosp-local-inference] Runtime is missing getModel/registerModel; cannot wire handlers.",
    );
    return false;
  }

  // `registerAospLlamaLoader` is typed against a duck-typed
  // `{ registerService?: (name, impl) => unknown }` shape — the runtime's
  // public typed `registerService(serviceDef: ServiceClass)` overload is
  // not assignable to that, but the runtime carries the older
  // (name, impl) overload too (used by `app-core`'s
  // `ensure-local-inference-handler.ts`). Cast through `unknown` to
  // pick up the loader-registration overload without widening the
  // adapter's public API.
  const registered = await registerAospLlamaLoader(
    runtime as unknown as Parameters<typeof registerAospLlamaLoader>[0],
  );
  if (!registered) {
    // registerAospLlamaLoader already logs the specific failure (missing
    // libllama.so, missing shim, bun:ffi unavailable, etc.). Surface
    // the no-op here so callers can see the chain failed.
    logger.error(
      "[aosp-local-inference] AOSP llama loader registration failed; TEXT_* handlers NOT wired.",
    );
    return false;
  }

  const loader = getRegisteredLoader(runtime);
  if (!loader) {
    logger.error(
      "[aosp-local-inference] Loader registered but not retrievable via getService('localInferenceLoader').",
    );
    return false;
  }

  const slots: Array<(typeof ModelType)[keyof typeof ModelType]> = [
    ModelType.TEXT_SMALL,
    ModelType.TEXT_LARGE,
  ];
  for (const modelType of slots) {
    runtimeWithRegistration.registerModel(
      modelType,
      makeGenerateHandler(loader),
      PROVIDER,
      LOCAL_INFERENCE_PRIORITY,
    );
  }

  // The AOSP loader exposes `embed` (bun:ffi via llama_get_embeddings_seq),
  // so wire TEXT_EMBEDDING too. If a future loader change drops the embed
  // surface, the makeEmbeddingHandler call would still work, but
  // `loader.embed` would throw — which is the correct behaviour
  // (Commandment 8: don't hide broken pipelines with silent zero-vectors).
  runtimeWithRegistration.registerModel(
    ModelType.TEXT_EMBEDDING,
    makeEmbeddingHandler(loader),
    PROVIDER,
    LOCAL_INFERENCE_PRIORITY,
  );

  logger.info(
    `[aosp-local-inference] Registered ${PROVIDER} handlers for TEXT_SMALL / TEXT_LARGE / TEXT_EMBEDDING at priority ${LOCAL_INFERENCE_PRIORITY}`,
  );
  return true;
}
