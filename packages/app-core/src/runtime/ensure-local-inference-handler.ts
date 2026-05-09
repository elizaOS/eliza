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
  type TextEmbeddingParams,
} from "@elizaos/core";
import {
  type LocalInferenceLoader,
  resolveLocalInferenceLoadArgs,
} from "../services/local-inference/active-model";
import {
  autoAssignAtBoot,
  readEffectiveAssignments,
} from "../services/local-inference/assignments";
import { extractPromptCacheKey } from "../services/local-inference/cache-bridge";
import { deviceBridge } from "../services/local-inference/device-bridge";
import { localInferenceEngine } from "../services/local-inference/engine";
import { handlerRegistry } from "../services/local-inference/handler-registry";
import { listInstalledModels } from "../services/local-inference/registry";
import { installRouterHandler } from "../services/local-inference/router-handler";
import type { AgentModelSlot } from "../services/local-inference/types";

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

const LOCAL_INFERENCE_PROVIDER = "eliza-local-inference";
const DEVICE_BRIDGE_PROVIDER = "eliza-device-bridge";
const CAPACITOR_LLAMA_PROVIDER = "capacitor-llama";
const AOSP_LLAMA_PROVIDER = "eliza-aosp-llama";
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

function makeHandler(slot: AgentModelSlot): GenerateTextHandler {
  return async (runtime, params) => {
    const loader = getLoader(runtime);

    // Lazy-load the assigned model for this slot, if any. Swaps are
    // expensive; the user is expected to assign a small number of models.
    await ensureAssignedModelLoaded(loader, slot);

    // Forward the runtime-emitted prompt cache key to the local backend
    // so the engine / llama-server can pin to a stable slot and reuse
    // its prefix KV. Cloud providers consume the same key from
    // `providerOptions.{provider}.promptCacheKey`; here we read the
    // canonical form from `providerOptions.eliza.promptCacheKey`.
    const cacheKey =
      extractPromptCacheKey(
        (params as { providerOptions?: unknown }).providerOptions,
      ) ?? undefined;

    // Prefer a runtime-registered loader that implements `generate` — that's
    // the mobile / device-bridge path. On desktop we fall back to the
    // standalone engine.
    if (loader?.generate) {
      return loader.generate({
        prompt: params.prompt ?? "",
        stopSequences: params.stopSequences,
        cacheKey,
      });
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
    return localInferenceEngine.generate({
      prompt: params.prompt ?? "",
      stopSequences: params.stopSequences,
      cacheKey,
    });
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
      "@elizaos/agent"
    )) as typeof import("@elizaos/agent") & {
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
		registerCapacitorLlamaLoader(
			runtime as unknown as Parameters<typeof registerCapacitorLlamaLoader>[0],
		);
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

export async function ensureLocalInferenceHandler(
  runtime: AgentRuntime,
): Promise<void> {
  const runtimeWithRegistration = runtime as RuntimeWithModelRegistration;
  if (
    typeof runtimeWithRegistration.getModel !== "function" ||
    typeof runtimeWithRegistration.registerModel !== "function"
  ) {
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
  // `number[]` instead of `string`, so it can't share `makeHandler`. We
  // only register when the active loader actually exposes `embed`;
  // otherwise the runtime should fall through to the operator-configured
  // embedding provider.
  const loaderForEmbed = (
    runtime as { getService?: (name: string) => unknown }
  ).getService?.("localInferenceLoader") as
    | { embed?: unknown }
    | null
    | undefined;
  if (loaderForEmbed && typeof loaderForEmbed.embed === "function") {
    try {
      runtimeWithRegistration.registerModel(
        ModelType.TEXT_EMBEDDING,
        makeEmbeddingHandler(),
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
}
