/**
 * Imperative renderer-side controller that captures presence/health/screen-time
 * activity signals and posts them to the LifeOps activity-signals endpoint:
 * browser lifecycle listeners on every platform, the Capacitor MobileSignals
 * plugin on native mobile, and the Electrobun power/workspace bridge on
 * desktop. Signals are deduped by per-source fingerprint and re-captured on app
 * resume.
 *
 * The renderer-service host starts this via `../register.ts`
 * (`registerRendererService`), passing its per-instance context through, scoped
 * to main app windows only — never popouts, detached shells, the phone
 * companion, app windows, or the model tester. The controller upholds four
 * hard guarantees (#16504, #17110):
 *
 * - **Idempotent start.** One capture per renderer: a second start while one
 *   is active returns the active capture's stop function instead of installing
 *   duplicate listeners/pollers. Stop fully releases the singleton so a later
 *   start re-initializes cleanly (host replacement, HMR).
 * - **Race-safe stop.** Native startup awaits (permission check, listener
 *   registration, monitor start) re-check the stop flag after every await:
 *   stopping mid-start removes the late listener handle, stops monitoring if
 *   it already engaged, and never installs a late poller interval.
 * - **No capture before consent.** Native monitoring starts only when the OS
 *   permission status is already "granted". This background service never
 *   prompts — requesting permission is the settings UI's job — and a denial
 *   is surfaced as a `permission_unavailable` status event, then re-checked on
 *   each app resume so a grant made in Settings activates without a restart.
 * - **Commit-after-success teardown.** `stop()` is async-capable: it removes
 *   the native listener, stops monitoring, cancels any scheduled background
 *   refresh, and awaits all of it before resolving, so the renderer-service
 *   registry can serialize a successor's start behind it (defect #2 of
 *   #17110 — a stale generation's in-flight `stopMonitoring()` can no longer
 *   land after the replacement's `startMonitoring()`). Symmetrically, native
 *   monitoring only *commits* its listener handle once `startMonitoring()`
 *   resolves `{ enabled: true }`; a rejection or `enabled: false` rolls the
 *   listener back instead of wedging the retry guard forever. The optional
 *   `context` (the registry's per-instance shell/signal) is accepted so this
 *   module's `start()` matches the renderer-service contract, but `signal` is
 *   deliberately not independently observed via an `abort` listener: the
 *   registry always calls this returned `stop` as the instance's cleanup in
 *   the same synchronous tick as aborting the signal, and a second listener
 *   racing that call would see `mounted` already false and hand back an
 *   already-resolved promise — silently orphaning the real, still in-flight
 *   teardown and defeating the serialization this fix exists to provide.
 *   `mounted` alone is the race-free source of truth every async
 *   continuation re-checks after its await, so a late completion (a
 *   resolved/rejected in-flight request, a delayed native event) discards
 *   itself instead of publishing after stop.
 *
 * Canonical auth state gates runtime readiness: a signed-out renderer makes no
 * protected status requests, and the capture arms immediately when the app's
 * existing auth probe publishes a valid session. A defensive 401/403 from an
 * already-armed request suspends the poller until auth publishes again.
 * Expected unavailability (runtime not yet running, transient network/timeout,
 * endpoint 503, a stale binding whose deleted agent answers with the structural
 * agent-gone 404) quietly stands the capture down.
 * Capability-specific 503s use a bounded retry interval because the global
 * runtime status cannot prove that this optional plugin route is active.
 * Anything else is surfaced observably: a `capture_error` status event plus a
 * prefixed console.error — but only while still mounted; a failure that lands
 * after stop is discarded rather than published. Teardown's own failures are
 * the exception: they always report (J6), since they are this instance's own
 * teardown, not a stale generation's late noise.
 */
import { Capacitor } from "@capacitor/core";
import {
  MobileSignals,
  type MobileSignalsHealthSnapshot,
  type MobileSignalsSignal,
  type MobileSignalsSnapshot,
} from "@elizaos/capacitor-mobile-signals";
// The LifeOps client methods this controller calls are installed onto
// ElizaClient.prototype by the client-lifeops side-effect module. Import it
// here, not just in the root facade: the register entry can evaluate before
// (or without) the PA root facade, and the capture must never race the
// prototype extension — without this import, boot-batch signals are lost and
// surface as spurious capture_error until the idle facade load lands.
import "../api/client-lifeops.js";
// Narrow @elizaos/ui subpaths only — the root barrel drags react-router and
// the full component tree into this headless register chunk, which both
// bloats the renderer bundle and breaks under node module resolution in test
// lanes. (isApiError also only carries its type-guard on the /api subpath.)
import {
  client as apiClient,
  isApiError,
  isCloudAgentGoneError,
} from "@elizaos/ui/api";
import {
  type AuthStatusState,
  isAuthenticatedNow,
  subscribeAuthStatus,
} from "@elizaos/ui/auth-status";
import { isElectrobunRuntime } from "@elizaos/ui/bridge";
import { loadDesktopWorkspaceSnapshot } from "@elizaos/ui/browser";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "@elizaos/ui/events";
import type { LifeOpsElizaClientMethods } from "../api/client-lifeops.js";
import type {
  CaptureLifeOpsActivitySignalRequest,
  LifeOpsActivitySignal,
} from "../contracts/index.js";
import { dispatchLifeOpsActivitySignalsStatus } from "../events/index.js";

// client-lifeops (imported above for its side effect) installs the LifeOps
// methods onto ElizaClient.prototype before this module body runs, but its
// declaration merge targets the `@elizaos/ui` root barrel only — this headless
// chunk imports the /api subpath, so it re-types its view of the client with
// the one LifeOps method it calls.
const client = apiClient as typeof apiClient &
  Pick<LifeOpsElizaClientMethods, "captureLifeOpsActivitySignal">;

const LOG_PREFIX = "[LifeOpsActivitySignals]";

const APP_SIGNAL_DEDUP_WINDOW_MS = 5_000;
const RUNTIME_READY_POLL_MS = 5_000;
const ACTIVITY_SIGNALS_CAPABILITY_RETRY_MS = 60_000;
const PAGE_HEARTBEAT_MS = 60_000;
const DESKTOP_POWER_POLL_MS = 60_000;
// Health sleep data drives wake detection; five-minute polling keeps morning
// anchors timely without running while mobile monitoring is stopped.
const MOBILE_HEALTH_POLL_MS = 5 * 60_000;

type SignalFingerprint = {
  fingerprint: string;
  sentAtMs: number;
};

interface CapacitorRuntime {
  getPlatform?: () => string;
  isNativePlatform?: () => boolean;
}

interface WindowWithCapacitor extends Window {
  Capacitor?: CapacitorRuntime;
}

function getWindowCapacitor(): CapacitorRuntime | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return (window as WindowWithCapacitor).Capacitor;
}

function resolveCapacitorPlatform(): string {
  const importedPlatform = Capacitor.getPlatform();
  if (importedPlatform !== "web") {
    return importedPlatform;
  }
  return getWindowCapacitor()?.getPlatform?.() ?? importedPlatform;
}

function isNativeCapacitorRuntime(): boolean {
  return (
    Capacitor.isNativePlatform() ||
    getWindowCapacitor()?.isNativePlatform?.() === true ||
    ["ios", "android"].includes(resolveCapacitorPlatform())
  );
}

function resolveActivityPlatform(): string {
  if (isElectrobunRuntime()) {
    return "desktop_app";
  }
  if (isNativeCapacitorRuntime()) {
    return "mobile_app";
  }
  return "web_app";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message.trim()
    : String(error);
}

function fingerprintSignal(
  signal: CaptureLifeOpsActivitySignalRequest,
): string {
  return JSON.stringify([
    signal.source,
    signal.platform ?? "",
    signal.state,
    signal.idleState ?? "",
    signal.idleTimeSeconds ?? "",
    signal.onBattery ?? "",
    signal.metadata ?? {},
  ]);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function toIsoOrNow(value: unknown): string {
  return toIsoOrNull(value) ?? new Date().toISOString();
}

function mapMobileSignal(
  signal: MobileSignalsSignal,
): CaptureLifeOpsActivitySignalRequest {
  return {
    source: signal.source,
    platform: signal.platform,
    state: signal.state,
    observedAt: toIsoOrNow(signal.observedAt),
    idleState: signal.idleState,
    idleTimeSeconds: signal.idleTimeSeconds ?? undefined,
    onBattery: signal.onBattery ?? undefined,
    health:
      signal.source === "mobile_health"
        ? {
            source: signal.healthSource,
            permissions: signal.permissions,
            sleep: {
              available: signal.sleep.available,
              isSleeping: signal.sleep.isSleeping,
              asleepAt: toIsoOrNull(signal.sleep.asleepAt),
              awakeAt: toIsoOrNull(signal.sleep.awakeAt),
              durationMinutes: signal.sleep.durationMinutes,
              stage: signal.sleep.stage,
            },
            biometrics: {
              sampleAt: toIsoOrNull(signal.biometrics.sampleAt),
              heartRateBpm: signal.biometrics.heartRateBpm,
              restingHeartRateBpm: signal.biometrics.restingHeartRateBpm,
              heartRateVariabilityMs: signal.biometrics.heartRateVariabilityMs,
              respiratoryRate: signal.biometrics.respiratoryRate,
              bloodOxygenPercent: signal.biometrics.bloodOxygenPercent,
            },
            warnings: signal.warnings,
          }
        : undefined,
    metadata:
      signal.source === "mobile_health"
        ? { ...signal.metadata, screenTime: signal.screenTime }
        : signal.metadata,
  };
}

// One capture per renderer window. The active stop function doubles as the
// idempotency token: repeated starts hand back the same stop instead of
// duplicating listeners/pollers, and stop releases it so re-init works.
let activeCaptureStop: (() => void | Promise<void>) | null = null;

/**
 * Minimal shape of the renderer-service host context (`RendererServiceContext`
 * from `@elizaos/ui/platform/renderer-services`) this module needs. Kept
 * local instead of importing the full type so this headless capture chunk
 * never pulls in the registry module at runtime — only structural typing.
 */
export interface LifeOpsActivitySignalCaptureContext {
  signal?: AbortSignal;
}

export function startLifeOpsActivitySignalCapture(
  enabled = true,
  context?: LifeOpsActivitySignalCaptureContext,
): () => void | Promise<void> {
  // A signal that is already aborted at call time (an instance the registry
  // stopped before its start settled — see `startInstance`'s own late-abort
  // check) must never install listeners/pollers that would then need a
  // second, redundant teardown. This one-time synchronous read is the safe
  // way to consume the signal: unlike an `abort` event listener, it cannot
  // race the registry's own paired abort()+cleanup() call (see `stop`).
  if (
    !enabled ||
    typeof window === "undefined" ||
    context?.signal?.aborted === true
  ) {
    return () => {};
  }
  if (activeCaptureStop) {
    return activeCaptureStop;
  }

  const platform = resolveActivityPlatform();
  const lastSent = new Map<string, SignalFingerprint>();
  let runtimeReady = false;
  let sessionAllowsReadiness = false;
  let runtimeReadinessGeneration = 0;
  let runtimePoller: number | null = null;
  let activitySignalsRetryAtMs = 0;
  let mounted = true;

  const stopRuntimeReadiness = (): void => {
    runtimeReadinessGeneration += 1;
    runtimeReady = false;
    if (runtimePoller !== null) {
      window.clearInterval(runtimePoller);
      runtimePoller = null;
    }
  };

  const suspendForUnavailableSession = (): void => {
    sessionAllowsReadiness = false;
    stopRuntimeReadiness();
  };

  const standDownActivitySignals = (): void => {
    runtimeReady = false;
    activitySignalsRetryAtMs =
      Date.now() + ACTIVITY_SIGNALS_CAPABILITY_RETRY_MS;
  };

  const isRuntimeUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    error.status === 503 &&
    error.path === "/api/lifeops/activity-signals";

  const isExpectedTransientError = (error: unknown): boolean =>
    isApiError(error) && (error.kind === "network" || error.kind === "timeout");

  const isUnavailableNativePluginError = (error: unknown): boolean =>
    error instanceof Error &&
    /["']?MobileSignals["']? plugin is not implemented on (?:android|ios)/i.test(
      error.message,
    );

  // A 401/403 is the designed signed-out state, not a capture defect. It also
  // means the canonical snapshot was stale relative to the protected request,
  // so fail closed and wait for a later auth publication instead of polling.
  const isSessionUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    (error.status === 401 || error.status === 403);

  // error-policy:J6 best-effort teardown — a failing disposer (native listener
  // removal, stopMonitoring, background-refresh cancellation) must not block
  // the rest of stop(), but unlike reportCaptureError this always reports:
  // it is this instance's OWN teardown, not a stale generation's late noise,
  // so it must stay observable even though `mounted` is already false by the
  // time these calls settle (#17110).
  const reportTeardownFailure = (error: unknown): void => {
    dispatchLifeOpsActivitySignalsStatus({
      status: "capture_error",
      message: errorMessage(error),
    });
  };

  const reportCaptureError = (error: unknown): void => {
    // A completion that lands after stop() belongs to a torn-down instance —
    // discard it rather than mutate state or publish a status event nobody
    // owns anymore (#17110 generation safety).
    if (!mounted) return;
    if (isSessionUnavailableError(error)) {
      suspendForUnavailableSession();
      return;
    }
    if (isRuntimeUnavailableError(error)) {
      standDownActivitySignals();
      return;
    }
    if (isUnavailableNativePluginError(error)) {
      standDownActivitySignals();
      return;
    }
    if (isExpectedTransientError(error) || isCloudAgentGoneError(error)) {
      return;
    }
    // Unexpected failure: surface it observably — status event for in-app
    // listeners plus a prefixed console line for log capture — instead of
    // letting the capture silently rot.
    console.error(`${LOG_PREFIX} unexpected capture failure:`, error);
    dispatchLifeOpsActivitySignalsStatus({
      status: "capture_error",
      message: errorMessage(error),
    });
  };

  // Runtime not up yet (boot, restart), signed-out (401/403), a stale binding
  // to a deleted agent (structural agent-gone 404), and a cloud-console base
  // with no runtime status endpoint (raw 404) are the designed stand-down
  // states; only those plus transport loss and the 503 "runtime starting"
  // shape count. Anything else coming out of the status probe (persistent
  // 500s included) is a real defect and must surface, not read as "not ready"
  // forever (#16504).
  const isExpectedProbeFailure = (error: unknown): boolean =>
    isSessionUnavailableError(error) ||
    isCloudAgentGoneError(error) ||
    (isApiError(error) &&
      (error.kind === "network" ||
        error.kind === "timeout" ||
        (error.kind === "http" &&
          (error.status === 503 || error.status === 404))));

  const refreshRuntimeReady = async (): Promise<boolean> => {
    if (!mounted || !sessionAllowsReadiness) {
      return false;
    }
    const generation = runtimeReadinessGeneration;
    try {
      const status = await client.getStatus();
      if (
        !mounted ||
        !sessionAllowsReadiness ||
        generation !== runtimeReadinessGeneration
      ) {
        return false;
      }
      const ready =
        status.state === "running" && Date.now() >= activitySignalsRetryAtMs;
      runtimeReady = ready;
      return ready;
    } catch (error) {
      if (
        !mounted ||
        !sessionAllowsReadiness ||
        generation !== runtimeReadinessGeneration
      ) {
        return false;
      }
      // error-policy:J4 capture stands down until a later poll succeeds;
      // unexpected probe failures still surface as a capture_error status.
      runtimeReady = false;
      if (isSessionUnavailableError(error)) {
        suspendForUnavailableSession();
      } else if (!isExpectedProbeFailure(error)) {
        reportCaptureError(error);
      }
      return false;
    }
  };

  const sendSignal = async (
    signal: CaptureLifeOpsActivitySignalRequest,
  ): Promise<LifeOpsActivitySignal | null> => {
    if (!mounted || !runtimeReady) {
      return null;
    }
    const normalized: CaptureLifeOpsActivitySignalRequest = {
      ...signal,
      platform: signal.platform ?? platform,
    };
    const fingerprint = fingerprintSignal(normalized);
    const dedupeKey = `${normalized.source}:${normalized.platform ?? ""}`;
    const previous = lastSent.get(dedupeKey);
    const nowMs = Date.now();
    if (
      previous &&
      previous.fingerprint === fingerprint &&
      nowMs - previous.sentAtMs < APP_SIGNAL_DEDUP_WINDOW_MS
    ) {
      return null;
    }
    lastSent.set(dedupeKey, { fingerprint, sentAtMs: nowMs });
    try {
      const { signal: persisted } =
        await client.captureLifeOpsActivitySignal(normalized);
      return persisted;
    } catch (error) {
      lastSent.delete(dedupeKey);
      if (isSessionUnavailableError(error)) {
        suspendForUnavailableSession();
        return null;
      }
      if (isRuntimeUnavailableError(error)) {
        standDownActivitySignals();
        return null;
      }
      throw error;
    }
  };

  const sendSnapshotResult = async (result: {
    snapshot: MobileSignalsSnapshot | null;
    healthSnapshot: MobileSignalsHealthSnapshot | null;
  }): Promise<void> => {
    if (result.snapshot) {
      await sendSignal(mapMobileSignal(result.snapshot));
    }
    if (result.healthSnapshot) {
      await sendSignal(mapMobileSignal(result.healthSnapshot));
    }
  };

  const fireAndForget = (signal: CaptureLifeOpsActivitySignalRequest): void => {
    void sendSignal(signal).catch(reportCaptureError);
  };

  const emitPageState = (reason: string): void => {
    const isVisible = document.visibilityState === "visible";
    const hasFocus =
      typeof document.hasFocus === "function" ? document.hasFocus() : true;
    fireAndForget({
      source: "page_visibility",
      state: isVisible && hasFocus ? "active" : "background",
      metadata: {
        reason,
        visibilityState: document.visibilityState,
        hasFocus,
      },
    });
  };

  const emitLifecycleState = (state: "active" | "background"): void => {
    fireAndForget({
      source: "app_lifecycle",
      state,
      metadata: { reason: state === "active" ? "resume" : "pause" },
    });
  };

  const emitDesktopSnapshot = async (reason: string): Promise<void> => {
    try {
      if (!isElectrobunRuntime()) {
        return;
      }
      const snapshot = await loadDesktopWorkspaceSnapshot();
      if (!snapshot.supported || !snapshot.power) {
        return;
      }

      const state =
        snapshot.power.idleState === "locked"
          ? "locked"
          : snapshot.power.idleState === "idle"
            ? "idle"
            : snapshot.window.focused && document.visibilityState === "visible"
              ? "active"
              : "background";
      await sendSignal({
        source: "desktop_power",
        state,
        idleState: snapshot.power.idleState,
        idleTimeSeconds: Math.max(0, Math.trunc(snapshot.power.idleTime)),
        onBattery: snapshot.power.onBattery,
        metadata: {
          reason,
          windowFocused: snapshot.window.focused,
          windowVisible: snapshot.window.visible,
          documentVisibility: document.visibilityState,
        },
      });
    } catch (error) {
      // error-policy:J7 the desktop snapshot poll must not kill the capture
      // loop; unexpected failures are surfaced through reportCaptureError.
      reportCaptureError(error);
    }
  };

  const handleVisibilityChange = (): void => {
    emitPageState("visibilitychange");
  };
  const handleFocus = (): void => {
    emitPageState("focus");
    void emitDesktopSnapshot("focus");
  };
  const handleBlur = (): void => {
    emitPageState("blur");
    void emitDesktopSnapshot("blur");
  };
  const handleResume = (): void => {
    emitLifecycleState("active");
    emitPageState("resume");
    void refreshMobileHealthSnapshot("resume").catch(reportCaptureError);
    void emitDesktopSnapshot("resume");
    // A permission granted in OS Settings while the app was backgrounded
    // becomes effective here: startMobileSignals re-checks consent and is a
    // cheap no-op when monitoring is already running.
    void startMobileSignals().catch(reportCaptureError);
  };
  const handlePause = (): void => {
    emitLifecycleState("background");
    emitPageState("pause");
    void refreshMobileHealthSnapshot("pause").catch(reportCaptureError);
    void emitDesktopSnapshot("pause");
  };

  const mobileSignals =
    isNativeCapacitorRuntime() && !isElectrobunRuntime() ? MobileSignals : null;
  let mobileSignalsHandle: { remove: () => Promise<void> } | null = null;
  let mobileSignalsStarted = false;
  let mobileSignalsStarting = false;
  // The whole native startup run (permissions → listener → startMonitoring →
  // snapshots → background refresh), including every unmounted-rollback path
  // inside it, is owned teardown work: stop() awaits it so a predecessor's
  // late rollback (listener removal, stopMonitoring of a just-engaged
  // monitor, re-cancel of a late-scheduled refresh) always lands before the
  // renderer-service registry may start a successor (#17110).
  let mobileSignalsInFlight: Promise<void> | null = null;
  let mobileHealthPoller: number | null = null;

  const refreshMobileHealthSnapshot = async (reason: string): Promise<void> => {
    if (!mobileSignals || typeof mobileSignals.getSnapshot !== "function") {
      return;
    }
    const snapshot = await mobileSignals.getSnapshot();
    // Discard a late resolution: a snapshot poll that outlives stop() must
    // not publish a status event for an instance nobody owns anymore.
    if (!mounted) return;
    if (snapshot.supported) {
      await sendSnapshotResult(snapshot);
    } else {
      dispatchLifeOpsActivitySignalsStatus({
        status: "snapshot_unavailable",
        reason,
      });
    }
  };

  const startMobileSignals = (): Promise<void> => {
    // The starting flag closes the concurrency window two callers (initial
    // ready check + ready poller + resume) would otherwise race through: the
    // handle/started guards below are only assigned after awaits.
    if (mobileSignalsStarting || mobileSignalsHandle || mobileSignalsStarted) {
      return Promise.resolve();
    }
    if (
      !mobileSignals ||
      typeof mobileSignals.addListener !== "function" ||
      typeof mobileSignals.checkPermissions !== "function" ||
      typeof mobileSignals.startMonitoring !== "function" ||
      typeof mobileSignals.stopMonitoring !== "function"
    ) {
      return Promise.resolve();
    }

    mobileSignalsStarting = true;
    const run = runMobileSignalsStartup();
    mobileSignalsInFlight = run;
    const clearInFlight = (): void => {
      if (mobileSignalsInFlight === run) {
        mobileSignalsInFlight = null;
      }
    };
    // error-policy:J5 a startup rejection is observed by every call site's
    // `.catch(reportCaptureError)` on the returned promise; this derived
    // promise exists only to clear the in-flight slot on settlement.
    void run.then(clearInFlight, clearInFlight);
    return run;
  };

  const runMobileSignalsStartup = async (): Promise<void> => {
    if (!mobileSignals) {
      return;
    }
    try {
      const permissions = await mobileSignals.checkPermissions();
      if (!mounted) return;
      if (
        permissions.status !== "granted" &&
        permissions.status !== "not-applicable"
      ) {
        // Consent gate: never begin monitoring (or prompt) without a grant.
        // The settings UI owns requesting; resume re-checks pick up a grant.
        dispatchLifeOpsActivitySignalsStatus({
          status: "permission_unavailable",
          reason: permissions.status,
        });
        return;
      }

      const handle = await mobileSignals.addListener(
        "signal",
        (signal: MobileSignalsSignal) => {
          void sendSignal(mapMobileSignal(signal)).catch(reportCaptureError);
        },
      );
      if (!mounted) {
        // Stopped while the listener registered: nothing was ever committed,
        // so remove the late handle and leave the retry guard clear.
        await handle.remove().catch(reportTeardownFailure);
        return;
      }

      // Commit-after-success (#17110): the handle is NOT committed to
      // `mobileSignalsHandle` yet — a rejecting or disabled startMonitoring
      // below must not leave a committed handle behind, or every later retry
      // (resume, permission grant) would wedge forever behind the guard at
      // the top of this function.
      let initial: Awaited<ReturnType<typeof mobileSignals.startMonitoring>>;
      try {
        initial = await mobileSignals.startMonitoring({ emitInitial: true });
      } catch (error) {
        await handle.remove().catch(reportTeardownFailure);
        throw error;
      }

      if (!mounted) {
        // Stopped while monitoring engaged: stand the native monitor down
        // and remove the never-committed listener.
        if (initial.enabled) {
          await mobileSignals.stopMonitoring().catch(reportTeardownFailure);
        }
        await handle.remove().catch(reportTeardownFailure);
        return;
      }

      if (!initial.enabled) {
        // Monitoring never actually engaged: roll back instead of committing
        // a handle for a monitor that isn't running.
        await handle.remove().catch(reportTeardownFailure);
        return;
      }

      // Commit only now that native monitoring is confirmed running.
      mobileSignalsHandle = handle;
      mobileSignalsStarted = true;
      await sendSnapshotResult(initial);
      await refreshMobileHealthSnapshot("start");
      if (!mounted) return;
      if (typeof mobileSignals.scheduleBackgroundRefresh === "function") {
        try {
          const result = await mobileSignals.scheduleBackgroundRefresh();
          if (!mounted) {
            // Stopped while scheduling was in flight: stop()'s
            // cancelBackgroundRefresh may have raced ahead of this schedule,
            // so a successful late schedule must be cancelled again — no
            // background job may outlive its generation. stop() awaits this
            // whole startup run, so the re-cancel lands before cleanup
            // resolves (#17110).
            if (
              result.scheduled &&
              typeof mobileSignals.cancelBackgroundRefresh === "function"
            ) {
              await mobileSignals
                .cancelBackgroundRefresh()
                .catch(reportTeardownFailure);
            }
            return;
          }
          if (!result.scheduled && result.reason) {
            dispatchLifeOpsActivitySignalsStatus({
              status: "background_refresh_unavailable",
              reason: result.reason,
            });
          }
        } catch (error) {
          // error-policy:J7 background-refresh scheduling is an enhancement;
          // its failure is reported without killing the started capture.
          reportCaptureError(error);
        }
      }
      if (!mounted) return;
      mobileHealthPoller = window.setInterval(() => {
        void refreshMobileHealthSnapshot("poll").catch(reportCaptureError);
      }, MOBILE_HEALTH_POLL_MS);
    } finally {
      mobileSignalsStarting = false;
    }
  };

  const emitCurrentState = (reason: string): void => {
    emitLifecycleState("active");
    emitPageState(reason);
    void emitDesktopSnapshot(reason);
    void refreshMobileHealthSnapshot(reason).catch(reportCaptureError);
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener(APP_RESUME_EVENT, handleResume);
  document.addEventListener(APP_PAUSE_EVENT, handlePause);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleBlur);

  const runRuntimeReadyProbe = (readyReason: string): void => {
    const wasReady = runtimeReady;
    void refreshRuntimeReady()
      .then((ready) => {
        if (!mounted || !ready || wasReady) {
          return;
        }
        emitCurrentState(readyReason);
        void startMobileSignals().catch(reportCaptureError);
      })
      .catch(reportCaptureError);
  };

  const startRuntimeReadiness = (initialReadyReason: string): void => {
    if (!mounted || !sessionAllowsReadiness || runtimePoller !== null) {
      return;
    }
    runRuntimeReadyProbe(initialReadyReason);
    runtimePoller = window.setInterval(() => {
      runRuntimeReadyProbe("runtime-ready");
    }, RUNTIME_READY_POLL_MS);
  };

  const updateSessionAvailability = (
    authenticated: boolean,
    initialReadyReason: string,
  ): void => {
    if (!authenticated) {
      if (sessionAllowsReadiness || runtimePoller !== null) {
        suspendForUnavailableSession();
      }
      return;
    }
    if (sessionAllowsReadiness) {
      return;
    }
    sessionAllowsReadiness = true;
    runtimeReadinessGeneration += 1;
    startRuntimeReadiness(initialReadyReason);
  };

  const handleAuthStatus = (state: AuthStatusState): void => {
    updateSessionAvailability(state.phase === "authenticated", "runtime-ready");
  };

  // Subscribe before reading the snapshot so an auth publication racing this
  // startup cannot be missed. A duplicate authenticated publication is a no-op.
  const unsubscribeAuthStatus = subscribeAuthStatus(handleAuthStatus);
  if (isAuthenticatedNow()) {
    updateSessionAvailability(true, "mount");
  }

  const pageHeartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      emitPageState("heartbeat");
    }
  }, PAGE_HEARTBEAT_MS);
  const desktopPoller = window.setInterval(() => {
    void emitDesktopSnapshot("poll");
  }, DESKTOP_POWER_POLL_MS);

  // Full teardown ownership (#17110): every synchronous release below (event
  // listeners, intervals) happens before any await, so a caller that invokes
  // `stop()` without awaiting it still observes those side effects
  // immediately. The native calls below are also *initiated* synchronously
  // (their in-flight promises are only collected, not chained behind each
  // other), but the returned promise resolves only once every one of them has
  // settled — the renderer-service registry awaits this before starting a
  // successor, so a stale generation's in-flight `stopMonitoring()` can never
  // land after (and disable) the replacement's `startMonitoring()`.
  const stop = (): Promise<void> => {
    if (!mounted) return Promise.resolve();
    mounted = false;
    if (activeCaptureStop === stop) {
      activeCaptureStop = null;
    }
    unsubscribeAuthStatus();
    sessionAllowsReadiness = false;
    stopRuntimeReadiness();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener(APP_RESUME_EVENT, handleResume);
    document.removeEventListener(APP_PAUSE_EVENT, handlePause);
    window.removeEventListener("focus", handleFocus);
    window.removeEventListener("blur", handleBlur);

    const pending: Promise<unknown>[] = [];
    if (mobileSignalsInFlight) {
      // The in-flight startup run performs its own unmounted rollback
      // (listener removal, stopMonitoring, background-refresh re-cancel)
      // once each pending native call settles; owning it here is what keeps
      // that rollback ahead of a successor's start.
      // error-policy:J5 a startup rejection is observed by the launch call
      // sites' `.catch(reportCaptureError)`; stop() needs only settlement.
      pending.push(mobileSignalsInFlight.catch(() => {}));
    }
    if (mobileSignalsHandle) {
      const handle = mobileSignalsHandle;
      mobileSignalsHandle = null;
      pending.push(handle.remove().catch(reportTeardownFailure));
    }
    if (mobileSignalsStarted && mobileSignals) {
      mobileSignalsStarted = false;
      pending.push(mobileSignals.stopMonitoring().catch(reportTeardownFailure));
      if (typeof mobileSignals.cancelBackgroundRefresh === "function") {
        pending.push(
          mobileSignals.cancelBackgroundRefresh().catch(reportTeardownFailure),
        );
      }
    }
    if (mobileHealthPoller !== null) {
      window.clearInterval(mobileHealthPoller);
      mobileHealthPoller = null;
    }
    window.clearInterval(pageHeartbeat);
    window.clearInterval(desktopPoller);

    return Promise.all(pending).then(() => undefined);
  };

  activeCaptureStop = stop;
  return stop;
}

/** True while a capture instance is active — diagnostics/tests only. */
export function isLifeOpsActivitySignalCaptureActive(): boolean {
  return activeCaptureStop !== null;
}
