/**
 * App-core Eliza runtime loader: the single boot chokepoint every app-core agent
 * process funnels through. Wraps `@elizaos/agent`'s startEliza / bootElizaRuntime
 * with app-shell concerns — installs the agent host bridge (vault, account pool,
 * wallet-key hydration, cloud-pair route), syncs brand env aliases, binds the
 * API server (bind-first, then background runtime boot), repairs the runtime,
 * and composes the focused startup modules that own autonomy, PGlite recovery,
 * local-model warmup, and post-ready contributor ordering.
 *
 * Contributor discovery, runtime repair, deferral policy, and server-only
 * lifecycle live in focused startup modules. This file retains the public API
 * compatibility wrappers and composes upstream boot with those modules.
 */
import "@elizaos/shared";
import process from "node:process";
import {
  type BootElizaRuntimeOptions,
  CUSTOM_PLUGINS_DIRNAME,
  resolvePackageEntry,
  type StartElizaOptions,
  scanDropInPlugins,
  applyCloudConfigToEnv as upstreamApplyCloudConfigToEnv,
  bootElizaRuntime as upstreamBootElizaRuntime,
  collectPluginNames as upstreamCollectPluginNames,
  startEliza as upstreamStartEliza,
} from "@elizaos/agent";
import { ensureBundledFusedLibDir } from "./bundled-fused-lib.js";
import { installAgentHostBridge } from "./install-agent-host-bridge.js";

export { CHANNEL_PLUGIN_MAP } from "./channel-plugin-map.js";

export { CUSTOM_PLUGINS_DIRNAME, resolvePackageEntry, scanDropInPlugins };

import { readAliasedEnv } from "@elizaos/shared";
import {
  createRuntimeBootResources,
  failRuntimeRepair,
  repairRuntimeAfterBoot,
  shutdownRuntime,
  stopRuntimeBootResources,
} from "./startup/app-runtime-host.js";
import {
  type EmbeddingProgressCallback,
  ensureDefaultEmbeddingDimension,
  prepareLocalEmbeddingWarmup,
  startDeferredLocalEmbeddingWarmup,
} from "./startup/local-model-warmup.js";
import {
  attemptPgliteAutoReset,
  getPgliteRecoveryRetrySkipPlugins,
  normalizePgliteStartupError,
} from "./startup/pglite-recovery.js";
import { startServerOnlyHost } from "./startup/server-only-host.js";

export {
  drainBootHookContributors,
  resolveBootHookContributors,
} from "@elizaos/agent/runtime/boot-hooks";
export {
  __loadAppRoutePluginFromSpecifierForTest,
  drainRuntimeHookContributors,
  getDeferAppRoutesEnabled,
  getSkippedAppRoutePluginIds,
  normalizeAppRoutePluginId,
} from "./startup/app-contributors.js";
export {
  createRuntimeBootResources,
  type PostReadyBootSteps,
  type RuntimeBootResources,
  runPostReadyBootTail,
  shutdownRuntime,
} from "./startup/app-runtime-host.js";

export function collectPluginNames(
  ...args: Parameters<typeof upstreamCollectPluginNames>
): ReturnType<typeof upstreamCollectPluginNames> {
  return upstreamCollectPluginNames(...args);
}

export function applyCloudConfigToEnv(
  ...args: Parameters<typeof upstreamApplyCloudConfigToEnv>
): ReturnType<typeof upstreamApplyCloudConfigToEnv> {
  return upstreamApplyCloudConfigToEnv(...args);
}

export { startDeferredLocalEmbeddingWarmup };

export interface BootElizaRuntimeOptionsExt extends BootElizaRuntimeOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
}

export async function bootElizaRuntime(
  opts: BootElizaRuntimeOptionsExt = {},
): Promise<Awaited<ReturnType<typeof upstreamBootElizaRuntime>>> {
  const bootResources = createRuntimeBootResources();
  // Eagerly download the embedding model before the full runtime boot.
  // This way the TUI loading screen (or server logs) can show download
  // progress instead of the app silently stalling on first embedding call.
  // Fire-and-forget: warmupEmbeddingModelImpl declares "non-fatal: will
  // retry on first use" semantics, and self-serializes via the module-level
  // warmupInFlight singleton. Awaiting it here parked bootstrap on sticky
  // HF 401 → multi-URL fallback chains with no overall deadline; the API
  // port never bound and dev-ui.mjs's 300s watchdog tore the stack down
  // (W-016). Voiding lets bootstrap proceed; the renderer's startup overlay
  // still surfaces progress through the startup overlay.
  prepareLocalEmbeddingWarmup(opts.onEmbeddingProgress);

  // Default the embedding-vector dimension plugin-sql provisions to 384 when
  // unset: that is the compact SQL-safe column and the native width of the
  // standalone gte-small embedding model. Setting it here lets plugin-sql
  // provision the column without a boot-time model probe (see core
  // provisioning). An explicit EMBEDDING_DIMENSION — a different local model,
  // the desktop Eliza-1 sidecar's Matryoshka width, or cloud embeddings —
  // still wins.
  ensureDefaultEmbeddingDimension();

  // The agent host drains registry-declared pre-ready hooks during initialize.
  // Expose the app-bundled native library before entering that shared path.
  ensureBundledFusedLibDir();

  const runtime = await upstreamBootElizaRuntime(opts);
  // Voice warmup fires inside repairRuntimeAfterBoot (the shared ready-point).
  if (!runtime) return runtime;
  try {
    return await repairRuntimeAfterBoot(runtime, bootResources);
  } catch (error) {
    // error-policy:J2 a failed app-core repair cannot leave the upstream
    // runtime alive after bootElizaRuntime rejects.
    return await failRuntimeRepair(runtime, "boot", error);
  }
}

export interface StartElizaOptionsExt extends StartElizaOptions {
  /** Optional callback for embedding model download/init progress. */
  onEmbeddingProgress?: EmbeddingProgressCallback;
  /**
   * Local-agent IPC mode: the frontend reaches the runtime over native IPC
   * (Capacitor / Electrobun RPC / stdio bridge), not an HTTP port. When set,
   * `startEliza` skips binding the API TCP listener unless the operator opts
   * back in via `ELIZA_API_EXPOSE_PORT`. The in-process route kernel is still
   * initialized so the IPC bridge can drive `dispatchRoute`. Default
   * false/unset — the desktop Electrobun launcher, `eliza start`, and the plain
   * server-only path leave this unset and keep binding the port exactly as
   * today. (#12180)
   */
  localAgentMode?: boolean;
  /** Receives the closeable server host without giving bootstrap process ownership. */
  onServerOnlyHostReady?: (
    host: import("./server-only-process").ServerOnlyHost,
  ) => void;
}

async function upstreamStartElizaWithPgliteCompat(
  options?: StartElizaOptions,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  // Inject the app-core host capabilities (vault, account pool, wallet-key
  // hydration, build variant, cloud-pair route) into the agent runtime before
  // it boots. Every app-core agent boot funnels through here, and this is the
  // sole caller of `upstreamStartEliza`, so the bridge is always installed
  // before agent code that reads it runs. See install-agent-host-bridge.ts.
  installAgentHostBridge();
  ensureBundledFusedLibDir();
  try {
    return await upstreamStartEliza(options);
  } catch (err) {
    // error-policy:J2 startup compatibility translation — preserve the
    // upstream database error as the normalized startup error's cause.
    throw normalizePgliteStartupError(err);
  }
}

export { attemptPgliteAutoReset, getPgliteRecoveryRetrySkipPlugins };

export async function startEliza(
  options?: StartElizaOptionsExt,
): Promise<Awaited<ReturnType<typeof upstreamStartEliza>>> {
  const bootResources = createRuntimeBootResources();
  // Eliza app: load PTY / coding-swarm orchestration unless explicitly opted out.
  const orchRaw = readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase();
  if (orchRaw !== "0" && orchRaw !== "false" && orchRaw !== "no") {
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
  }

  // Eagerly download the embedding model with progress reporting.
  // Fire-and-forget — see comment at the matching call in bootElizaRuntime
  // (W-016): awaiting parks bootstrap; voiding lets the API port bind on
  // time while the warmup runs alongside.
  prepareLocalEmbeddingWarmup(options?.onEmbeddingProgress);

  // Cap embedding dimension to 384 — see comment in bootElizaRuntime.
  ensureDefaultEmbeddingDimension();

  if (options?.serverOnly) {
    return await startServerOnlyHost({
      options,
      bootRuntime: async (onPostReadyPhase) => {
        const booted =
          (await upstreamStartElizaWithPgliteCompat({
            ...options,
            headless: true,
            serverOnly: false,
          })) ?? undefined;
        if (!booted) return booted;
        try {
          return await repairRuntimeAfterBoot(
            booted,
            bootResources,
            onPostReadyPhase,
          );
        } catch (error) {
          // error-policy:J2 the server host never publishes a runtime whose
          // app-core repair failed, and cleanup preserves the failure cause.
          return await failRuntimeRepair(booted, "server-only-boot", error);
        }
      },
      stopRuntime: shutdownRuntime,
      stopWithoutRuntime: () => stopRuntimeBootResources(bootResources),
    });
  }

  const runtime = await upstreamStartElizaWithPgliteCompat(options);
  if (!runtime) return runtime;
  try {
    return await repairRuntimeAfterBoot(runtime, bootResources);
  } catch (error) {
    // error-policy:J2 startEliza owns the unpublished runtime until repair
    // succeeds, so rejection includes teardown and preserves the cause.
    return await failRuntimeRepair(runtime, "start", error);
  }
}
