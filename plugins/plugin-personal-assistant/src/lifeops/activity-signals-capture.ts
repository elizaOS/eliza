/**
 * Imperative renderer-side controller that captures native mobile
 * presence/health/screen-time snapshots via the Capacitor MobileSignals plugin
 * (and desktop power/screen-time via the Electrobun bridge), deduping by
 * per-signal fingerprint and re-capturing on app resume. It subscribes to
 * browser lifecycle events and posts to the LifeOps activity-signals endpoint,
 * standing down quietly on incapable devices or while the runtime endpoint is
 * unavailable.
 *
 * PA self-starts this at app boot through `../register.ts` (the `appRegister`
 * side-effect module the renderer loads after first paint), so the capture runs
 * for the app lifetime without the GUI shell mounting a React effect (#16504).
 *
 * Lifecycle contract: `startLifeOpsActivitySignalCapture()` is an idempotent
 * process-wide singleton — a second start while active returns the existing
 * stop function, so re-evaluation (HMR host replacement) can never double the
 * listeners or pollers. The returned stop is race-safe against the async native
 * startup: every awaited MobileSignals step re-checks the stop flag, and a stop
 * that lands mid-startup removes the late listener, halts monitoring, and
 * installs no interval. A non-bfcache `pagehide` triggers the same stop so
 * native monitoring never outlives the page.
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
// (or without) the facade, and the capture must never race the extension.
import "../api/client-lifeops.js";
// Narrow @elizaos/ui subpaths only — the root barrel drags react-router and
// the full component tree into this headless capture path, which both bloats
// the renderer chunk and breaks under node module resolution in test lanes.
import { client, isApiError } from "@elizaos/ui/api";
import { isElectrobunRuntime } from "@elizaos/ui/bridge";
import { loadDesktopWorkspaceSnapshot } from "@elizaos/ui/browser";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "@elizaos/ui/events";
import type {
  CaptureLifeOpsActivitySignalRequest,
  LifeOpsActivitySignal,
} from "../contracts/index.js";
import { dispatchLifeOpsActivitySignalsStatus } from "../events/index.js";

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

// Process-wide singleton stop handle. Non-null exactly while a capture is
// active; a concurrent second start returns this instead of duplicating work.
let activeStop: (() => void) | null = null;

export function startLifeOpsActivitySignalCapture(enabled = true): () => void {
  if (!enabled || typeof window === "undefined") {
    return () => {};
  }
  if (activeStop) {
    return activeStop;
  }

  const platform = resolveActivityPlatform();
  const lastSent = new Map<string, SignalFingerprint>();
  let runtimeReady = false;
  let stopped = false;

  const isRuntimeUnavailableError = (error: unknown): boolean =>
    isApiError(error) &&
    error.kind === "http" &&
    error.status === 503 &&
    error.path === "/api/lifeops/activity-signals";

  const reportCaptureError = (error: unknown): void => {
    if (isRuntimeUnavailableError(error)) {
      runtimeReady = false;
      return;
    }
    if (
      isApiError(error) &&
      (error.kind === "network" || error.kind === "timeout")
    ) {
      // error-policy:J4 transient transport loss is the designed quiet state
      // for a background capture feed; the runtime-ready poller re-probes.
      return;
    }
    dispatchLifeOpsActivitySignalsStatus({
      status: "capture_error",
      message: errorMessage(error),
    });
  };

  // Runtime not up yet (boot, restart) is the designed stand-down state; only
  // transport loss and the 503 "runtime starting" shape count as that state.
  // Anything else coming out of the status probe is a real defect and must
  // surface, not read as "not ready" forever (#16504).
  const isExpectedProbeFailure = (error: unknown): boolean =>
    isApiError(error) &&
    (error.kind === "network" ||
      error.kind === "timeout" ||
      (error.kind === "http" && error.status === 503));

  const refreshRuntimeReady = async (): Promise<boolean> => {
    try {
      const status = await client.getStatus();
      const ready = status.state === "running";
      runtimeReady = ready;
      return ready;
    } catch (error) {
      // error-policy:J4 capture stands down until a later poll succeeds;
      // unexpected probe failures still surface as a capture_error status.
      runtimeReady = false;
      if (!isExpectedProbeFailure(error)) {
        reportCaptureError(error);
      }
      return false;
    }
  };

  const sendSignal = async (
    signal: CaptureLifeOpsActivitySignalRequest,
  ): Promise<LifeOpsActivitySignal | null> => {
    if (stopped || !runtimeReady) {
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
      // error-policy:J7 telemetry capture must not kill the poll loop; the
      // classifier surfaces unexpected failures as a capture_error status.
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
  };
  const handlePause = (): void => {
    emitLifecycleState("background");
    emitPageState("pause");
    void refreshMobileHealthSnapshot("pause").catch(reportCaptureError);
    void emitDesktopSnapshot("pause");
  };

  const mobileSignals =
    isNativeCapacitorRuntime() && !isElectrobunRuntime() ? MobileSignals : null;
  // The live mobile session's disposer — set only after a fully successful
  // startup; a startup interrupted by stop() or a thrown step disposes its own
  // partial installs and never publishes here.
  let mobileSession: { dispose: () => void } | null = null;
  let mobileSessionStarting = false;

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
    if (stopped || mobileSession || mobileSessionStarting) {
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
    mobileSessionStarting = true;

    let handle: { remove: () => Promise<void> } | null = null;
    let monitoring = false;
    let healthPoller: number | null = null;
    const dispose = (): void => {
      const currentHandle = handle;
      handle = null;
      if (currentHandle) {
        void currentHandle.remove().catch(reportCaptureError);
      }
      if (monitoring) {
        monitoring = false;
        void mobileSignals.stopMonitoring().catch(reportCaptureError);
      }
      if (healthPoller !== null) {
        window.clearInterval(healthPoller);
        healthPoller = null;
      }
    };

    try {
      await mobileSignals.checkPermissions();
      if (stopped) return;

      handle = await mobileSignals.addListener(
        "signal",
        (signal: MobileSignalsSignal) => {
          void sendSignal(mapMobileSignal(signal)).catch(reportCaptureError);
        },
      );
      if (stopped) return;

      const initial = await mobileSignals.startMonitoring({
        emitInitial: true,
      });
      monitoring = initial.enabled;
      if (stopped) return;

      await sendSnapshotResult(initial);
      await refreshMobileHealthSnapshot("start");
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
          // error-policy:J4 background refresh is an optional enhancement on
          // top of live monitoring; its failure surfaces as a status event
          // without tearing down the already-running session.
          reportCaptureError(error);
        }
      }
      if (stopped) return;

      healthPoller = window.setInterval(() => {
        void refreshMobileHealthSnapshot("poll").catch(reportCaptureError);
      }, MOBILE_HEALTH_POLL_MS);
      mobileSession = { dispose };
    } finally {
      mobileSessionStarting = false;
      // Failed or stop-interrupted startups reach here without publishing the
      // session: undo whatever partial native installs already landed.
      if (!mobileSession) {
        dispose();
      }
    }
  };

  const emitCurrentState = (reason: string): void => {
    emitLifecycleState("active");
    emitPageState(reason);
    void emitDesktopSnapshot(reason);
    void refreshMobileHealthSnapshot(reason).catch(reportCaptureError);
  };

  void refreshRuntimeReady().then((ready) => {
    if (ready && !stopped) {
      emitCurrentState("mount");
      void startMobileSignals().catch(reportCaptureError);
    }
  });

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener(APP_RESUME_EVENT, handleResume);
  document.addEventListener(APP_PAUSE_EVENT, handlePause);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("blur", handleBlur);

  const runtimePoller = window.setInterval(() => {
    const wasReady = runtimeReady;
    void refreshRuntimeReady().then((ready) => {
      if (stopped || !ready || wasReady) {
        return;
      }
      emitCurrentState("runtime-ready");
      void startMobileSignals().catch(reportCaptureError);
    });
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
    if (stopped) {
      return;
    }
    stopped = true;
    if (activeStop === stop) {
      activeStop = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener(APP_RESUME_EVENT, handleResume);
    document.removeEventListener(APP_PAUSE_EVENT, handlePause);
    window.removeEventListener("focus", handleFocus);
    window.removeEventListener("blur", handleBlur);
    window.removeEventListener("pagehide", handlePageHide);
    mobileSession?.dispose();
    mobileSession = null;
    window.clearInterval(runtimePoller);
    window.clearInterval(pageHeartbeat);
    window.clearInterval(desktopPoller);
  };

  // Real page teardown must halt native monitoring; a bfcache round trip
  // (persisted=true) keeps the capture alive because the page can come back.
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      stop();
    }
  };
  window.addEventListener("pagehide", handlePageHide);

  activeStop = stop;
  return stop;
}
