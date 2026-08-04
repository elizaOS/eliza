/**
 * App-runtime repair and resource lifecycle after the upstream agent boots. It
 * applies pre-ready hooks and autonomy, schedules the observable post-ready
 * tail, and guarantees that runtime-scoped bridges are released on shutdown.
 */
import process from "node:process";
import {
  loadElizaConfig,
  shutdownRuntime as upstreamShutdownRuntime,
} from "@elizaos/agent";
import { markDeferredBootPhase } from "@elizaos/agent/runtime/deferred-boot-status";
import {
  type AgentRuntime,
  CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
  ElizaError,
  logger,
  type TargetSource,
} from "@elizaos/core";
import {
  ensureRuntimeSqlCompatibility,
  formatError,
  formatErrorWithStack,
  isMobilePlatform,
} from "@elizaos/shared";
import { registerSubAgentCredentialBridgeAdapter } from "../../services/credential-tunnel-service";
import { registerCoreSensitiveRequestAdapters } from "../../services/sensitive-requests/index.js";
import { isRuntimeAutonomyEnabled } from "../autonomy-policy.js";
import { ensureBundledFusedLibDir } from "../bundled-fused-lib.js";
import { registerSubAgentCredentialBridge } from "../sub-agent-credential-bridge-wiring.js";
import {
  getDeferAppRoutesEnabled,
  registerAppRoutePlugins,
  registerRuntimeHooks,
  runBootHooks,
} from "./app-contributors.js";
import { configureAutonomy } from "./autonomy.js";
import { startDeferredVoiceWarmup } from "./local-model-warmup.js";
import {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  type RuntimeBootResources,
  runPostReadyBootTail,
} from "./post-ready.js";

const runtimeBootResources = new WeakMap<AgentRuntime, RuntimeBootResources>();

export async function repairRuntimeAfterBoot(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
  onPostReadyPhase?: (phase: "pending" | "complete" | "failed") => void,
): Promise<AgentRuntime> {
  runtimeBootResources.set(runtime, resources);
  await ensureRuntimeSqlCompatibility(runtime);

  // Make the app-bundled fused libelizainference (staged into the desktop
  // package) discoverable before any local-inference handler probes
  // `supported()`. No-op in dev / on mobile and when an explicit override is
  // set. Must run before the boot hooks (which install the local-inference
  // handler) below.
  ensureBundledFusedLibDir();

  // Pre-ready boot hooks: registry-declared init steps that must run before the
  // runtime is marked ready (e.g. installing the local model handler so it's
  // present for the first turn). This is where plugin-local-inference's boot
  // now lives — the mobile-voice-invariant warning + the platform-appropriate
  // model-handler registration are owned by its `registerLocalInferenceBoot`
  // hook (declared in registry-entry.json), NOT hard-wired here by name
  // (arch-audit #12089 item 18). The hook owns its platform gating, so it runs
  // identically on mobile (gated handler-ensure) and desktop (unconditional
  // handler-ensure), and emits the mobile-gate warning on either platform.
  await runBootHooks(runtime);

  // Mobile (Android / iOS) shortcut: the runtime is already serving from
  // PGlite + the AI provider plugin. The remaining boot steps either spawn
  // subprocesses (workflow runtime, telegram polling), shell
  // out to platform-specific binaries (text-to-speech, local inference), or
  // dynamic-import optional packages that are not in the mobile bundle
  // (registered app route plugins and app runtime hooks). Skipping
  // them here is what the mobile bundle has to do to avoid crashing on first
  // turn — feature parity comes from cloud-side services, not on-device state.
  // (The local model handler, when a mobile-safe backend is wired, was already
  // installed by the boot hooks above.)
  if (isMobilePlatform()) {
    logger.info(
      "[eliza] Mobile platform detected — skipping desktop-only boot helpers",
    );
    markDeferredBootPhase("app-route-tail", "complete");
    onPostReadyPhase?.("complete");
    return runtime;
  }

  await configureAutonomy(runtime, isRuntimeAutonomyEnabled(process.env));

  // Post-ready tail: feature-route plugins, training hooks, sensitive-request
  // adapters, telegram polling, the trigger bridge, the connector catalog, and
  // voice warmup. None of these gate correctness of the first turn, so by
  // default they run in the background and ready flips before the tail
  // completes (feature routes may 404 for a brief window — poll /api/health
  // `deferredBoot.settled` before hitting them). ELIZA_DEFER_APP_ROUTES=0
  // opts into awaiting the same tail inline. The phase is marked pending before ready can flip so
  // a health probe never reads a not-yet-announced tail as settled.
  resources.tailRuntime = runtime;
  markDeferredBootPhase("app-route-tail", "pending");
  onPostReadyPhase?.("pending");
  if (getDeferAppRoutesEnabled()) {
    void runPostReadyBootTail(
      runtime,
      createPostReadyBootSteps(resources),
      resources,
    ).then(
      () => onPostReadyPhase?.("complete"),
      (err: unknown) => {
        // error-policy:J1 boundary translation — the deferred tail has no caller
        // left to throw to; a contributor or runtime-hook failure here would
        // otherwise vanish into an unhandled rejection. Mark the phase failed
        // (so health-pollers stop waiting) and surface it agent-visibly.
        markDeferredBootPhase("app-route-tail", "failed");
        logger.error(
          `[eliza] post-ready boot tail failed: ${formatErrorWithStack(err)}`,
        );
        runtime.reportError("eliza.postReadyBootTail", err, {
          phase: "app-route-tail",
        });
        onPostReadyPhase?.("failed");
      },
    );
    return runtime;
  }
  try {
    await runPostReadyBootTail(
      runtime,
      createPostReadyBootSteps(resources),
      resources,
    );
    onPostReadyPhase?.("complete");
  } catch (err) {
    // error-policy:J2 context-preserving rethrow — inline mode makes a tail
    // failure fail boot; the phase marker prevents health from staying pending.
    markDeferredBootPhase("app-route-tail", "failed");
    onPostReadyPhase?.("failed");
    throw err;
  }
  return runtime;
}

/**
 * The post-ready boot steps, named so a focused unit test can inject stubs and
 * assert ordering / deferral / liveness / error-isolation without loading the
 * full runtime. Production passes {@link DEFAULT_POST_READY_BOOT_STEPS}.
 */
function createPostReadyBootSteps(
  resources: RuntimeBootResources,
): PostReadyBootSteps {
  return {
    registerAppRoutePlugins,
    registerRuntimeHooks,
    registerCoreSensitiveRequestAdapters,
    registerSubAgentCredentialBridge,
    registerSubAgentCredentialBridgeAdapter,
    ensureTriggerEventBridge: (runtime) =>
      ensureTriggerEventBridge(runtime, resources),
    ensureConnectorTargetCatalog: (runtime) =>
      ensureConnectorTargetCatalog(runtime, resources),
    startDeferredVoiceWarmup,
  };
}

export {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  type RuntimeBootResources,
  runPostReadyBootTail,
};

const CONNECTOR_TARGET_CATALOG_SERVICE_TYPE = "connector_target_catalog";

async function ensureTriggerEventBridge(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
): Promise<void> {
  if (resources.triggerEventBridge) {
    resources.triggerEventBridge.stop();
    resources.triggerEventBridge = null;
  }
  const { startTriggerEventBridge } = await import(
    "../../services/trigger-event-bridge.js"
  );
  resources.triggerEventBridge = startTriggerEventBridge(runtime);
  logger.info("[eliza] trigger event bridge armed");
}

async function ensureConnectorTargetCatalog(
  runtime: AgentRuntime,
  resources: RuntimeBootResources,
): Promise<void> {
  if (resources.connectorTargetCatalog) {
    resources.connectorTargetCatalog.stop();
    resources.connectorTargetCatalog = null;
  }
  const { createElizaConnectorTargetCatalog } = await import(
    "../../services/connector-target-catalog.js"
  );
  const catalog = createElizaConnectorTargetCatalog({
    getConfig: () => loadElizaConfig(),
    listSources: () => {
      const registry = runtime.getService(
        CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
      ) as { list(): TargetSource[] } | null;
      return registry?.list() ?? [];
    },
    logger: { warn: runtime.logger.warn.bind(runtime.logger) },
  });
  runtime.services.set(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE as never, [
    catalog as never,
  ]);
  resources.connectorTargetCatalog = {
    stop: () => {
      runtime.services.delete(CONNECTOR_TARGET_CATALOG_SERVICE_TYPE as never);
    },
  };
  logger.info("[eliza] connector-target-catalog registered");
}

export function stopRuntimeBootResources(
  resources: RuntimeBootResources,
): void {
  resources.tailRuntime = null;
  if (resources.triggerEventBridge) {
    try {
      resources.triggerEventBridge.stop();
    } catch (error) {
      // error-policy:J6 bridge teardown must not prevent the remaining host
      // resources from being released.
      logger.warn(
        `[eliza] Trigger event bridge stop failed during shutdown: ${formatError(error)}`,
      );
    }
    resources.triggerEventBridge = null;
  }
  if (resources.connectorTargetCatalog) {
    try {
      resources.connectorTargetCatalog.stop();
    } catch (error) {
      // error-policy:J6 catalog teardown must not prevent runtime shutdown.
      logger.warn(
        `[eliza] Connector target catalog stop failed during shutdown: ${formatError(error)}`,
      );
    }
    resources.connectorTargetCatalog = null;
  }
}

export async function shutdownRuntime(
  ...args: Parameters<typeof upstreamShutdownRuntime>
): Promise<Awaited<ReturnType<typeof upstreamShutdownRuntime>>> {
  const runtime = args[0];
  if (runtime) {
    const resources = runtimeBootResources.get(runtime);
    if (resources) {
      stopRuntimeBootResources(resources);
      runtimeBootResources.delete(runtime);
    }
  }
  return await upstreamShutdownRuntime(...args);
}

export async function failRuntimeRepair(
  runtime: AgentRuntime,
  scope: "boot" | "server-only-boot" | "start",
  repairError: unknown,
): Promise<never> {
  try {
    await shutdownRuntime(runtime, `${scope} repair failed`);
  } catch (shutdownError) {
    // error-policy:J2 preserve both the repair and cleanup failures so neither
    // root cause is hidden at the startup boundary.
    throw new ElizaError("Runtime repair and cleanup failed", {
      code: "APP_RUNTIME_REPAIR_CLEANUP_FAILED",
      cause: new AggregateError([repairError, shutdownError]),
      context: { scope },
      severity: "fatal",
    });
  }
  throw new ElizaError("App-core runtime repair failed", {
    code: "APP_RUNTIME_REPAIR_FAILED",
    cause: repairError,
    context: { scope },
    severity: "fatal",
  });
}
