/**
 * Registers the standalone llama.cpp engine as the runtime handler for
 * `ModelType.TEXT_SMALL` and `ModelType.TEXT_LARGE` when no higher-priority
 * provider has claimed those slots.
 *
 * Priority is -1 (below the default 0 used by cloud and direct provider plugins)
 * so the Milady router's manual tie-break prefers Eliza Cloud / API providers
 * when the user configured them. Local inference remains available when it is
 * the only option, or when the user explicitly prefers it in routing settings.
 *
 * Parallels `ensure-text-to-speech-handler.ts` — same shape, same guards.
 */

import {
  type AgentRuntime,
  type GenerateTextParams,
  type IAgentRuntime,
  logger,
  ModelType,
} from "@elizaos/core";
import type { LocalInferenceLoader } from "../services/local-inference/active-model";
import { readAssignments } from "../services/local-inference/assignments";
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

type RuntimeWithModelRegistration = AgentRuntime & {
  getModel: (modelType: string | number) => GenerateTextHandler | undefined;
  registerModel: (
    modelType: string | number,
    handler: GenerateTextHandler,
    provider: string,
    priority?: number,
  ) => void;
};

const LOCAL_INFERENCE_PROVIDER = "milady-local-inference";
/** Below default plugin priority (0) so cloud/direct providers win unless the user prefers local. */
const LOCAL_INFERENCE_PRIORITY = -1;

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
  const assignments = await readAssignments();
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
    await loader.loadModel({ modelPath: target.path });
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

    // Prefer a runtime-registered loader that implements `generate` — that's
    // the mobile / device-bridge path. On desktop we fall back to the
    // standalone engine.
    if (loader?.generate) {
      return loader.generate({
        prompt: params.prompt,
        stopSequences: params.stopSequences,
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
      prompt: params.prompt,
      stopSequences: params.stopSequences,
    });
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
  };
  withRegistration.registerService("localInferenceLoader", loader);
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
    const mod = (await import("@elizaos/capacitor-llama")) as unknown as {
      registerCapacitorLlamaLoader?: (r: AgentRuntime) => void;
    };
    if (typeof mod.registerCapacitorLlamaLoader === "function") {
      mod.registerCapacitorLlamaLoader(runtime);
      logger.info(
        "[local-inference] Registered capacitor-llama loader for mobile on-device inference",
      );
      return true;
    }
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

  // Belt-and-braces: the prototype-level patch installed by
  // `handler-registry.ts` at module import catches future registrations.
  // Calling installOn here is a no-op in the common case but ensures
  // runtimes constructed before the patch was loaded still get wrapped.
  handlerRegistry.installOn(runtime);

  // Loader precedence:
  //   1. Capacitor native adapter when running on a mobile device itself.
  //   2. Device-bridge (WebSocket to a paired phone) when explicitly
  //      opted in via ELIZA_DEVICE_BRIDGE_ENABLED=1.
  //   3. Standalone node-llama-cpp engine for desktop / server.
  //
  // All three satisfy the same `localInferenceLoader` service contract.
  // A later registration overrides an earlier one, so the loader that
  // wins is the one registered LAST. We check conditions top-down and
  // register bottom-up to preserve that precedence.
  const capacitorRegistered = await tryRegisterCapacitorLoader(runtime);
  const deviceBridgeEnabled =
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
  if (!capacitorRegistered && deviceBridgeEnabled) {
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
    !capacitorRegistered &&
    !deviceBridgeEnabled &&
    !(await localInferenceEngine.available())
  ) {
    logger.debug(
      "[local-inference] No local inference backend available; skipping model registration",
    );
    return;
  }

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
        LOCAL_INFERENCE_PROVIDER,
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

  logger.info(
    `[local-inference] Registered local llama.cpp handler for TEXT_SMALL / TEXT_LARGE at priority ${LOCAL_INFERENCE_PRIORITY}`,
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
