/**
 * Imperative renderer-side controller that captures presence/health/screen-time
 * activity signals and posts them to the LifeOps activity-signals endpoint:
 * browser lifecycle listeners on every platform, the Capacitor MobileSignals
 * plugin on native mobile, and the Electrobun power/workspace bridge on
 * desktop. Signals are deduped by per-source fingerprint and re-captured on app
 * resume.
 *
 * The renderer-service host starts this via `../register.ts`
 * (`registerRendererService`), scoped to main app windows only — never
 * popouts, detached shells, the phone companion, app windows, or the model
 * tester. The controller upholds three hard guarantees (#16504):
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
 *
 * Expected unavailability (runtime not yet running, transient network/timeout,
 * endpoint 503) quietly stands the capture down until the ready-poll recovers.
 * Anything else is an unexpected failure and is surfaced observably: a
 * `capture_error` status event plus a prefixed console.error.
 */
import { Capacitor } from "@capacitor/core";
import {
  MobileSignals,
  type MobileSignalsHealthSnapshot,
  type MobileSignalsSignal,
  type MobileSignalsSnapshot,
} from "@elizaos/capacitor-mobile-signals";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  client,
  isElectrobunRuntime,
} from "@elizaos/ui";
// isApiError / loadDesktopWorkspaceSnapshot live on the /api and /browser
// subpaths, not the @elizaos/ui root barrel; importing them from the root left
// isApiError untyped, which collapsed its type-guard.
import { isApiError } from "@elizaos/ui/api";
import { loadDesktopWorkspaceSnapshot } from "@elizaos/ui/browser";
import type {
  CaptureLifeOpsActivitySignalRequest,
  LifeOpsActivitySignal,
} from "../contracts/index.js";
import { dispatchLifeOpsActivitySignalsStatus } from "../events/index.js";

const LOG_PREFIX = "[LifeOpsActivitySignals]";

const APP_SIGNAL_DEDUP_WINDOW_MS = 5_000;
const RUNTIME_READY_POLL_MS = 5_000;
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
let activeCaptureStop: (() => void) | null = null;

export function startLifeOpsActivitySignalCapture(enabled = true): () => void {
  if (!enabled || typeof window === "undefined") {
    return () => {};
  }
  if (activeCaptureStop) {
    return activeCaptureStop;
  }

  const platform = resolveActivityPlatform();
  const lastSent = new Map<string, SignalFingerprint>();
  let runtimeReady = false;
  let mounted = true;

  const isRuntimeUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    error.status === 503 &&
    error.path === "/api/lifeops/activity-signals";

  const isExpectedTransientError = (error: unknown): boolean =>
    isApiError(error) && (error.kind === "network" || error.kind === "timeout");

  const reportCaptureError = (error: unknown): void => {
    if (isRuntimeUnavailableError(error)) {
      runtimeReady = false;
      return;
    }
    if (isExpectedTransientError(error)) {
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

  const refreshRuntimeReady = async (): Promise<boolean> => {
    try {
      const status = await client.getStatus();
      const ready = status.state === "running";
      runtimeReady = ready;
      return ready;
    } catch (error) {
      // error-policy:J4 an unreachable status endpoint is the designed
      // "runtime not up yet" state: capture stands down until the ready poll
      // recovers. Only API-shaped transport errors qualify — anything else is
      // unexpected and surfaced before standing down.
      if (!isApiError(error)) {
        reportCaptureError(error);
      }
      runtimeReady = false;
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
      if (isRuntimeUnavailableError(error)) {
        runtimeReady = false;
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
  let mobileHealthPoller: number | null = null;

  const refreshMobileHealthSnapshot = async (reason: string): Promise<void> => {
    if (!mobileSignals || typeof mobileSignals.getSnapshot !== "function") {
      return;
    }
    const snapshot = await mobileSignals.getSnapshot();
    if (snapshot.supported) {
      await sendSnapshotResult(snapshot);
    } else {
      dispatchLifeOpsActivitySignalsStatus({
        status: "snapshot_unavailable",
        reason,
      });
    }
  };

  const startMobileSignals = async (): Promise<void> => {
    // The starting flag closes the concurrency window two callers (initial
    // ready check + ready poller + resume) would otherwise race through: the
    // handle/started guards below are only assigned after awaits.
    if (mobileSignalsStarting || mobileSignalsHandle || mobileSignalsStarted) {
      return;
    }
    if (
      !mobileSignals ||
      typeof mobileSignals.addListener !== "function" ||
      typeof mobileSignals.checkPermissions !== "function" ||
      typeof mobileSignals.startMonitoring !== "function" ||
      typeof mobileSignals.stopMonitoring !== "function"
    ) {
      return;
    }

    mobileSignalsStarting = true;
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
        // Stopped while the listener registered: remove the late handle.
        void handle.remove().catch(() => {
          // error-policy:J6 best-effort removal of a just-created listener on
          // a torn-down capture; nothing observes this handle anymore.
        });
        return;
      }
      mobileSignalsHandle = handle;

      const initial = await mobileSignals.startMonitoring({
        emitInitial: true,
      });
      if (!mounted) {
        // Stopped while monitoring engaged: stand the native monitor down.
        if (initial.enabled) {
          void mobileSignals.stopMonitoring().catch(reportCaptureError);
        }
        return;
      }
      mobileSignalsStarted = initial.enabled;
      await sendSnapshotResult(initial);
      await refreshMobileHealthSnapshot("start");
      if (!mounted) return;
      if (typeof mobileSignals.scheduleBackgroundRefresh === "function") {
        try {
          const result = await mobileSignals.scheduleBackgroundRefresh();
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

  void refreshRuntimeReady()
    .then((ready) => {
      if (ready && mounted) {
        emitCurrentState("mount");
        void startMobileSignals().catch(reportCaptureError);
      }
    })
    .catch(reportCaptureError);

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener(APP_RESUME_EVENT, handleResume);
  document.addEventListener(APP_PAUSE_EVENT, handlePause);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleBlur);

  const runtimePoller = window.setInterval(() => {
    const wasReady = runtimeReady;
    void refreshRuntimeReady()
      .then((ready) => {
        if (!mounted || !ready || wasReady) {
          return;
        }
        emitCurrentState("runtime-ready");
        void startMobileSignals().catch(reportCaptureError);
      })
      .catch(reportCaptureError);
  }, RUNTIME_READY_POLL_MS);
  const pageHeartbeat = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      emitPageState("heartbeat");
    }
  }, PAGE_HEARTBEAT_MS);
  const desktopPoller = window.setInterval(() => {
    void emitDesktopSnapshot("poll");
  }, DESKTOP_POWER_POLL_MS);

  const stop = (): void => {
    if (!mounted) return;
    mounted = false;
    if (activeCaptureStop === stop) {
      activeCaptureStop = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener(APP_RESUME_EVENT, handleResume);
    document.removeEventListener(APP_PAUSE_EVENT, handlePause);
    window.removeEventListener("focus", handleFocus);
    window.removeEventListener("blur", handleBlur);
    if (mobileSignalsHandle) {
      void mobileSignalsHandle.remove().catch(() => {
        // error-policy:J6 best-effort native listener removal on teardown; the
        // capture is already stopped and nothing consumes the handle.
      });
      mobileSignalsHandle = null;
    }
    if (mobileSignalsStarted) {
      void mobileSignals?.stopMonitoring().catch(reportCaptureError);
      mobileSignalsStarted = false;
    }
    if (mobileHealthPoller !== null) {
      window.clearInterval(mobileHealthPoller);
      mobileHealthPoller = null;
    }
    window.clearInterval(runtimePoller);
    window.clearInterval(pageHeartbeat);
    window.clearInterval(desktopPoller);
  };

  activeCaptureStop = stop;
  return stop;
}

/** True while a capture instance is active — diagnostics/tests only. */
export function isLifeOpsActivitySignalCaptureActive(): boolean {
  return activeCaptureStop !== null;
}
