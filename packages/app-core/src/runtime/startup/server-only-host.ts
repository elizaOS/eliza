/**
 * Server-only app host lifecycle for bind-first startup. It owns API binding,
 * onboarding deferral, runtime publication/restart, sandbox registration, and
 * idempotent resource shutdown without owning process signals or exit policy.
 */
import process from "node:process";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  formatError,
  readAliasedEnv,
  resolveApiExposePort,
  resolveDesktopApiPort,
  resolveServerOnlyPort,
  syncResolvedApiPort,
} from "@elizaos/shared";
import {
  isRuntimeBootDeferred,
  registerDeferredRuntimeBoot,
  shouldDeferRuntimeBootUntilOnboarding,
  triggerDeferredRuntimeBoot,
} from "../../api/deferred-runtime-boot.js";
import { startApiServer } from "../../api/server.js";
import { invalidateCorsAllowedPorts } from "../../api/server-cors.js";
import { bootLap } from "../../boot-profile.js";
import type { ServerOnlyHost } from "../server-only-process.js";
import {
  type AppStartupPhase,
  AppStartupStateMachine,
} from "../startup-state.js";

export interface ServerOnlyHostOptions {
  localAgentMode?: boolean;
  onServerOnlyHostReady?: (host: ServerOnlyHost) => void;
}

type PostReadyPhase = "pending" | "complete" | "failed";

export interface StartServerOnlyHostOptions {
  options: ServerOnlyHostOptions;
  bootRuntime: (
    onPostReadyPhase: (phase: PostReadyPhase) => void,
  ) => Promise<AgentRuntime | undefined>;
  stopRuntime: (runtime: AgentRuntime, reason: string) => Promise<unknown>;
  stopWithoutRuntime: () => void;
}

export async function startServerOnlyHost({
  options,
  bootRuntime,
  stopRuntime,
  stopWithoutRuntime,
}: StartServerOnlyHostOptions): Promise<AgentRuntime | undefined> {
  bootLap("startEliza:serverOnly entry");
  let currentRuntime: AgentRuntime | undefined;
  let runtimePublished = false;
  let postReadyPhase: "pending" | "complete" | "failed" = "pending";
  const startup = new AppStartupStateMachine();
  const publishStartup = (phase: AppStartupPhase): void => {
    const snapshot = startup.transition(phase);
    updateStartup?.({
      phase: snapshot.phase,
      attempt: snapshot.attempt,
      state: snapshot.agentState,
    });
  };
  const publishPostReadyPhase = (
    phase: "pending" | "complete" | "failed",
  ): void => {
    postReadyPhase = phase;
    if (!runtimePublished) return;
    publishStartup(
      phase === "pending"
        ? "features-starting"
        : phase === "complete"
          ? "ready"
          : "degraded",
    );
  };

  // The caller owns upstream boot and app-core repair; this host owns when a
  // repaired runtime becomes visible to the HTTP layer.
  const bootServerOnlyRuntime = () => bootRuntime(publishPostReadyPhase);

  // Fresh-install gate, decided BEFORE the API binds so the onRestart
  // closure below can never race an in-flight deferral decision: on a
  // genuinely-fresh install (the GUI will run onboarding; no provider env
  // keys, not cloud-provisioned) the runtime a server-only boot would build
  // is pure waste — onboarding discards it. Defer it and boot on the
  // first-run commit instead (see ../api/deferred-runtime-boot.ts).
  const deferRuntimeBootUntilOnboarding =
    shouldDeferRuntimeBootUntilOnboarding();

  // Desktop launcher sets ELIZA_API_PORT (default 31337) to match the
  // renderer's hardcoded API base; honor it when present. CLI/server-only
  // mode (no ELIZA_API_PORT) keeps the legacy `resolveServerOnlyPort`
  // default (2138) so this change is transparent for non-desktop users.
  // The presence check is alias-aware so a branded `MILADY_API_PORT` also
  // selects the desktop port without relying on the process.env mirror.
  const apiPort = readAliasedEnv("ELIZA_API_PORT")
    ? resolveDesktopApiPort(process.env)
    : resolveServerOnlyPort(process.env);
  let actualApiPort: number;
  let updateRuntime:
    | Awaited<ReturnType<typeof startApiServer>>["updateRuntime"]
    | undefined;
  let updateStartup:
    | Awaited<ReturnType<typeof startApiServer>>["updateStartup"]
    | undefined;
  let closeApiServer: (() => Promise<void>) | undefined;
  // Local-agent IPC mode binds NO TCP listener (frontend reaches the
  // runtime over native IPC), unless the operator opts back in with
  // ELIZA_API_EXPOSE_PORT for dev tooling / LAN access / e2e harnesses.
  // Every other caller (desktop launcher, `eliza start`, plain server-only)
  // leaves `localAgentMode` unset, so binding remains the default. (#12180)
  const skipApiListen =
    options.localAgentMode === true &&
    resolveApiExposePort(process.env) !== true;
  if (skipApiListen) {
    bootLap("startEliza:local-agent IPC mode — skipping API TCP bind");
    logger.info(
      "[eliza] Local-agent IPC mode: initializing route kernel without a TCP listener (set ELIZA_API_EXPOSE_PORT=1 to re-open the port)",
    );
  }
  // The deferred fresh-install boot: exactly the post-bind boot sequence
  // below (boot → updateRuntime → "running"), reachable from the first-run
  // commit handler and the agent start/restart endpoints. Registered BEFORE
  // the API binds so every HTTP trigger finds it; `updateRuntime` /
  // `updateStartup` are assigned by the bind below, before any request can
  // arrive. A failed boot flips the reported state to "error" (the client's
  // designed error state) and rethrows — the registration is kept so an
  // explicit start/restart can retry.
  if (deferRuntimeBootUntilOnboarding) {
    registerDeferredRuntimeBoot(async () => {
      runtimePublished = false;
      postReadyPhase = "pending";
      publishStartup("runtime-starting");
      try {
        currentRuntime = await bootServerOnlyRuntime();
      } catch (err) {
        // error-policy:J2 context-adding rethrow — flip the reported agent
        // state to "error" first so /api/status never reads healthy.
        publishStartup("failed");
        throw new Error("Runtime boot after onboarding failed", {
          cause: err,
        });
      }
      if (!currentRuntime) {
        publishStartup("failed");
        throw new Error("Runtime boot after onboarding returned no runtime");
      }
      updateRuntime?.(currentRuntime);
      runtimePublished = true;
      publishPostReadyPhase(postReadyPhase);
      bootLap("startEliza:deferred runtime booted + ready:true");
    });
  }

  bootLap(
    "startEliza:before startApiServer (config/registry/embedding setup done)",
  );
  try {
    // Bind the API server FIRST with no runtime yet (state "starting", or
    // "not_started" when the fresh-install gate deferred the boot), so the
    // desktop webview connects + hydrates in PARALLEL with the heavier
    // agent boot instead of waiting the full boot. The runtime is wired in
    // via updateRuntime once it finishes booting below. Mirrors the
    // dev-server's bind-first orchestration. In local-agent IPC mode
    // (skipApiListen) the same route kernel is initialized in-process but no
    // socket is opened; the IPC bridge drives dispatchRoute directly.
    const startedApiServer = await startApiServer({
      port: apiPort,
      skipListen: skipApiListen,
      initialAgentState: deferRuntimeBootUntilOnboarding
        ? "not_started"
        : "starting",
      onRestart: async () => {
        // Before the deferred first boot has succeeded, a restart request
        // IS the boot request — funnel it into the single-flight trigger so
        // it can never race the first-run commit into a second concurrent
        // PGlite open.
        if (isRuntimeBootDeferred()) {
          await triggerDeferredRuntimeBoot("agent start requested via API");
          return currentRuntime ?? null;
        }
        if (currentRuntime) {
          await stopRuntime(currentRuntime, "server-only restart");
        }
        runtimePublished = false;
        postReadyPhase = "pending";
        publishStartup("runtime-starting");
        try {
          currentRuntime = await bootServerOnlyRuntime();
        } catch (error) {
          // error-policy:J1 restart orchestration boundary — publish a failed
          // lifecycle state before propagating the boot failure to the route.
          publishStartup("failed");
          throw error;
        }
        if (!currentRuntime) {
          publishStartup("failed");
          return null;
        }
        runtimePublished = true;
        publishPostReadyPhase(postReadyPhase);
        return currentRuntime ?? null;
      },
    });
    actualApiPort = startedApiServer.port;
    updateRuntime = startedApiServer.updateRuntime;
    updateStartup = startedApiServer.updateStartup;
    closeApiServer = startedApiServer.close;
    publishStartup("api-bound");
  } catch (apiErr) {
    // error-policy:J1 API-bind boundary — publish terminal startup state and
    // propagate the bind failure to the CLI/process owner.
    const apiErrMsg =
      apiErr instanceof Error
        ? (apiErr.stack ?? apiErr.message)
        : String(apiErr);
    logger.error(`[eliza] API server failed to start: ${apiErrMsg}`);
    publishStartup("failed");
    throw apiErr;
  }

  if (!skipApiListen) {
    // WHY: `startApiServer` may bind a different port than requested (busy
    // socket, upstream policy). Shells, scripts, and follow-up code reading
    // env must match the real listener or health checks and user-facing URLs
    // disagree with `GET /api/health`. In local-agent IPC mode no port is
    // bound, so syncing env to `actualApiPort` (a never-bound port) or
    // emitting a "listening on http://…" URL would be a lie.
    syncResolvedApiPort(process.env, actualApiPort, {
      overwriteUiPort: true,
    });
    // CORS caches resolved ports, so a rebound listener must invalidate the
    // cache before any renderer request is evaluated.
    invalidateCorsAllowedPorts();

    logger.info(
      `[eliza] API server listening on http://localhost:${actualApiPort} (agent booting…)`,
    );
    logger.info(`[eliza] Control UI: http://localhost:${actualApiPort}`);
    bootLap("startEliza:API bound (webview can connect, ready:false)");
  } else {
    logger.info(
      "[eliza] Local-agent IPC mode: route kernel ready (no TCP listener bound)",
    );
    bootLap("startEliza:route kernel ready (IPC mode, no TCP bind)");
  }

  if (deferRuntimeBootUntilOnboarding) {
    // Fresh install: no runtime until onboarding commits. The API server
    // already serves everything onboarding needs (first-run status/options,
    // auth, config); /api/status reports the designed awaiting state
    // (state "not_started", startup.phase "awaiting-onboarding") — never a
    // fake "running". The boot fires from POST /api/first-run (local-target
    // commit) or POST /api/agent/start|restart, whichever comes first; a
    // cloud/remote-target commit leaves this process runtime-less on
    // purpose (#13377 — the client binds the cloud agent instead).
    publishStartup("awaiting-onboarding");
    logger.info(
      "[eliza] Fresh install — agent runtime boot deferred until onboarding commits (onboarding API routes are live)",
    );
    bootLap("startEliza:runtime boot deferred (awaiting onboarding)");
  } else {
    // Now boot the runtime; the API is already reachable (state "starting"),
    // so the UI is connecting + hydrating while this runs, then flips to
    // "running" once the agent is ready.
    publishStartup("runtime-starting");
    try {
      currentRuntime = await bootServerOnlyRuntime();
    } catch (error) {
      // error-policy:J1 initial-boot boundary — close the already-bound API
      // server and propagate failure after publishing terminal startup state.
      publishStartup("failed");
      await closeApiServer?.();
      throw error;
    }
    if (!currentRuntime) {
      publishStartup("failed");
      await closeApiServer?.();
      return currentRuntime;
    }
    updateRuntime?.(currentRuntime);
    runtimePublished = true;
    publishPostReadyPhase(postReadyPhase);
    bootLap("startEliza:runtime booted + ready:true");
  }

  logger.info("[eliza] Server running. Press Ctrl+C to stop.");

  const { buildSandboxRegistryFromEnv } = await import(
    "@elizaos/shared/sandbox-registry"
  );
  const sandboxRegistry = buildSandboxRegistryFromEnv();
  if (sandboxRegistry) {
    try {
      await sandboxRegistry.register();
    } catch (err) {
      // error-policy:J7 registry heartbeat can recover after an initial
      // registration failure; surface the degraded routing path to the agent.
      logger.error(
        `[eliza] Failed to register sandbox in Redis (gateways will not route inbound platform messages here until the next heartbeat succeeds): ${formatError(err)}`,
      );
      currentRuntime?.reportError("eliza.sandboxRegistry", err, {
        phase: "register",
      });
    }
    sandboxRegistry.startHeartbeat(30_000);
  }

  let isClosed = false;
  const close = async (): Promise<void> => {
    if (isClosed) return;
    isClosed = true;
    runtimePublished = false;
    publishStartup("stopping");
    await closeApiServer?.();
    if (sandboxRegistry) {
      sandboxRegistry.stopHeartbeat();
      try {
        await sandboxRegistry.unregister();
      } catch (err) {
        // error-policy:J6 best-effort teardown — Redis keys expire by TTL and
        // the shutdown path remains observable through this warning.
        logger.warn(
          `[eliza] Sandbox unregister failed (keys will expire via TTL): ${formatError(err)}`,
        );
      }
    }
    if (currentRuntime) {
      await stopRuntime(currentRuntime, "server-only shutdown");
    } else {
      stopWithoutRuntime();
    }
  };
  options.onServerOnlyHostReady?.({
    port: actualApiPort,
    getRuntime: () => currentRuntime,
    close,
  });
  return currentRuntime;
}
