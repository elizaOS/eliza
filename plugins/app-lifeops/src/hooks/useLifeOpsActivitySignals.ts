import { Capacitor } from "@capacitor/core";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  client,
  isApiError,
  isElectrobunRuntime,
  loadDesktopWorkspaceSnapshot,
} from "@elizaos/ui";
import {
  MobileSignals,
  type MobileSignalsHealthSnapshot,
  type MobileSignalsSignal,
  type MobileSignalsSnapshot,
} from "@elizaos/capacitor-mobile-signals";
import { useEffect, useRef } from "react";
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

export function useLifeOpsActivitySignals(enabled = true): void {
  const platformRef = useRef(resolveActivityPlatform());
  const lastSentRef = useRef<Map<string, SignalFingerprint>>(new Map());
  const runtimeReadyRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let mounted = true;

    const isRuntimeUnavailableError = (error: unknown): boolean =>
      isApiError(error) &&
      error.kind === "http" &&
      error.status === 503 &&
      error.path === "/api/lifeops/activity-signals";

    const reportCaptureError = (error: unknown): void => {
      if (isRuntimeUnavailableError(error)) {
        runtimeReadyRef.current = false;
        return;
      }
      if (
        isApiError(error) &&
        (error.kind === "network" ||
          error.kind === "timeout" ||
          (error.status === 503 &&
            error.path === "/api/lifeops/activity-signals"))
      ) {
        return;
      }
      dispatchLifeOpsActivitySignalsStatus({
        status: "capture_error",
        message: errorMessage(error),
      });
    };

    const refreshRuntimeReady = async (): Promise<boolean> => {
      try {
        const status = await client.getStatus();
        const ready = status.state === "running";
        runtimeReadyRef.current = ready;
        return ready;
      } catch {
        runtimeReadyRef.current = false;
        return false;
      }
    };

    const sendSignal = async (
      signal: CaptureLifeOpsActivitySignalRequest,
    ): Promise<LifeOpsActivitySignal | null> => {
      if (!mounted || !runtimeReadyRef.current) {
        return null;
      }
      const normalized: CaptureLifeOpsActivitySignalRequest = {
        ...signal,
        platform: signal.platform ?? platformRef.current,
      };
      const fingerprint = fingerprintSignal(normalized);
      const dedupeKey = `${normalized.source}:${normalized.platform ?? ""}`;
      const previous = lastSentRef.current.get(dedupeKey);
      const nowMs = Date.now();
      if (
        previous &&
        previous.fingerprint === fingerprint &&
        nowMs - previous.sentAtMs < APP_SIGNAL_DEDUP_WINDOW_MS
      ) {
        return null;
      }
      lastSentRef.current.set(dedupeKey, { fingerprint, sentAtMs: nowMs });
      try {
        const { signal: persisted } =
          await client.captureLifeOpsActivitySignal(normalized);
        return persisted;
      } catch (error) {
        lastSentRef.current.delete(dedupeKey);
        if (isRuntimeUnavailableError(error)) {
          runtimeReadyRef.current = false;
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

    const fireAndForget = (
      signal: CaptureLifeOpsActivitySignalRequest,
    ): void => {
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
              : snapshot.window.focused &&
                  document.visibilityState === "visible"
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
      void refreshMobileHealthSnapshot("resume");
      void emitDesktopSnapshot("resume");
    };
    const handlePause = (): void => {
      emitLifecycleState("background");
      emitPageState("pause");
      void refreshMobileHealthSnapshot("pause");
      void emitDesktopSnapshot("pause");
    };

    const mobileSignals =
      isNativeCapacitorRuntime() && !isElectrobunRuntime()
        ? MobileSignals
        : null;
    let mobileSignalsHandle: { remove: () => Promise<void> } | null = null;
    let mobileSignalsStarted = false;
    let mobileHealthPoller: number | null = null;

    const refreshMobileHealthSnapshot = async (
      reason: string,
    ): Promise<void> => {
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
      if (mobileSignalsHandle || mobileSignalsStarted) {
        return;
      }
      if (
        !mobileSignals ||
        typeof mobileSignals.addListener !== "function" ||
        typeof mobileSignals.checkPermissions !== "function" ||
        typeof mobileSignals.requestPermissions !== "function" ||
        typeof mobileSignals.startMonitoring !== "function" ||
        typeof mobileSignals.stopMonitoring !== "function"
      ) {
        return;
      }

      const permissions = await mobileSignals.checkPermissions();
      if (permissions.status !== "granted" && permissions.canRequest) {
        await mobileSignals.requestPermissions();
      }

      mobileSignalsHandle = await mobileSignals.addListener(
        "signal",
        (signal: MobileSignalsSignal) => {
          void sendSignal(mapMobileSignal(signal)).catch(reportCaptureError);
        },
      );
      const initial = await mobileSignals.startMonitoring({
        emitInitial: true,
      });
      mobileSignalsStarted = initial.enabled;
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
          reportCaptureError(error);
        }
      }
      mobileHealthPoller = window.setInterval(() => {
        void refreshMobileHealthSnapshot("poll").catch(reportCaptureError);
      }, MOBILE_HEALTH_POLL_MS);
    };

    const emitCurrentState = (reason: string): void => {
      emitLifecycleState("active");
      emitPageState(reason);
      void emitDesktopSnapshot(reason);
      void refreshMobileHealthSnapshot(reason).catch(reportCaptureError);
    };

    void refreshRuntimeReady()
      .then((ready) => {
        if (ready) {
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
      const wasReady = runtimeReadyRef.current;
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

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      document.removeEventListener(APP_RESUME_EVENT, handleResume);
      document.removeEventListener(APP_PAUSE_EVENT, handlePause);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
      if (mobileSignalsHandle) {
        void mobileSignalsHandle.remove();
      }
      if (mobileSignalsStarted) {
        void mobileSignals?.stopMonitoring().catch(reportCaptureError);
      }
      if (mobileHealthPoller !== null) {
        window.clearInterval(mobileHealthPoller);
      }
      window.clearInterval(runtimePoller);
      window.clearInterval(pageHeartbeat);
      window.clearInterval(desktopPoller);
    };
  }, [enabled]);
}
