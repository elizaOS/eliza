import { WebPlugin } from "@capacitor/core";
import type {
  MobileSignalsHealthSnapshot,
  MobileSignalsOpenSettingsOptions,
  MobileSignalsOpenSettingsResult,
  MobileSignalsPermissionStatus,
  MobileSignalsPlatform,
  MobileSignalsPlugin,
  MobileSignalsScreenTimeStatus,
  MobileSignalsSetupAction,
  MobileSignalsSnapshot,
  MobileSignalsSnapshotResult,
  MobileSignalsStartOptions,
  MobileSignalsStartResult,
  MobileSignalsStopResult,
} from "./definitions";

type Cleanup = () => void;
interface BatteryLike {
  charging: boolean;
  level: number;
}

const SCREEN_TIME_REQUIREMENTS = {
  entitlements: {
    familyControls: "com.apple.developer.family-controls",
  },
  frameworks: ["FamilyControls", "DeviceActivity"],
  deviceActivityReportExtension: false,
  deviceActivityMonitorExtension: false,
  android: {
    usageStatsPermission: "android.permission.PACKAGE_USAGE_STATS",
    usageAccessSettingsAction: "android.settings.USAGE_ACCESS_SETTINGS",
  },
};

function getPlatform(): MobileSignalsPlatform {
  if (typeof navigator === "undefined") {
    return "web";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ipod")) {
    return "ios";
  }
  return "web";
}

function buildScreenTimeStatus(reason: string): MobileSignalsScreenTimeStatus {
  return {
    supported: false,
    requirements: SCREEN_TIME_REQUIREMENTS,
    entitlements: {
      familyControls: false,
    },
    provisioning: {
      satisfied: false,
      inspected: "not-inspectable",
      reason,
    },
    authorization: {
      status: "unavailable",
      canRequest: false,
    },
    reportAvailable: false,
    coarseSummaryAvailable: false,
    thresholdEventsAvailable: false,
    rawUsageExportAvailable: false,
    android: {
      usageAccessGranted: false,
      packageUsageStatsPermissionDeclared: false,
      canOpenUsageAccessSettings: false,
      foregroundEventsAvailable: false,
      totalTimeForegroundMs: null,
    },
    reason,
  };
}

function buildSetupActions(reason: string): MobileSignalsSetupAction[] {
  return [
    {
      id: "health_permissions",
      label: "Health permissions",
      status: "unavailable",
      canRequest: false,
      canOpenSettings: false,
      settingsTarget: null,
      reason,
    },
    {
      id: "screen_time_authorization",
      label: "Screen Time",
      status: "unavailable",
      canRequest: false,
      canOpenSettings: false,
      settingsTarget: null,
      reason: "Web fallback cannot open native Screen Time settings.",
    },
  ];
}

async function getBatterySnapshot(): Promise<{
  onBattery: boolean | null;
  batteryLevel: number | null;
  isCharging: boolean | null;
}> {
  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & {
          getBattery?: () => Promise<BatteryLike>;
        })
      : null;
  if (!nav || typeof nav.getBattery !== "function") {
    return { onBattery: null, batteryLevel: null, isCharging: null };
  }
  const battery = await nav.getBattery();
  return {
    onBattery: !battery.charging,
    batteryLevel:
      typeof battery.level === "number"
        ? Math.max(0, Math.min(1, battery.level))
        : null,
    isCharging: battery.charging,
  };
}

async function buildSnapshot(reason: string): Promise<MobileSignalsSnapshot> {
  const isVisible =
    typeof document !== "undefined"
      ? document.visibilityState === "visible"
      : true;
  const hasFocus =
    typeof document !== "undefined" && typeof document.hasFocus === "function"
      ? document.hasFocus()
      : true;
  const battery = await getBatterySnapshot();
  const state: MobileSignalsSnapshot["state"] =
    isVisible && hasFocus ? "active" : "background";
  const idleState: MobileSignalsSnapshot["idleState"] = isVisible
    ? "active"
    : "idle";
  return {
    source: "mobile_device",
    platform: getPlatform(),
    state,
    observedAt: Date.now(),
    idleState,
    idleTimeSeconds: null,
    onBattery: battery.onBattery,
    metadata: {
      reason,
      visibilityState:
        typeof document !== "undefined" ? document.visibilityState : "visible",
      hasFocus,
      ...battery,
    },
  };
}

function buildHealthSnapshot(reason: string): MobileSignalsHealthSnapshot {
  return {
    source: "mobile_health",
    platform: getPlatform(),
    state: "idle",
    observedAt: Date.now(),
    idleState: null,
    idleTimeSeconds: null,
    onBattery: null,
    healthSource: "healthkit",
    screenTime: buildScreenTimeStatus(
      "Web fallback has no Family Controls or DeviceActivity access.",
    ),
    permissions: {
      sleep: false,
      biometrics: false,
    },
    sleep: {
      available: false,
      isSleeping: false,
      asleepAt: null,
      awakeAt: null,
      durationMinutes: null,
      stage: null,
    },
    biometrics: {
      sampleAt: null,
      heartRateBpm: null,
      restingHeartRateBpm: null,
      heartRateVariabilityMs: null,
      respiratoryRate: null,
      bloodOxygenPercent: null,
    },
    warnings: [`web fallback has no health access (${reason})`],
    metadata: {
      reason,
      platform: getPlatform(),
      supported: false,
    },
  };
}

export class MobileSignalsWeb extends WebPlugin implements MobileSignalsPlugin {
  private monitoring = false;
  private cleanup: Cleanup[] = [];

  async checkPermissions(): Promise<MobileSignalsPermissionStatus> {
    return {
      status: "not-applicable",
      canRequest: false,
      screenTime: buildScreenTimeStatus(
        "Web fallback has no Family Controls or DeviceActivity access.",
      ),
      setupActions: buildSetupActions(
        "Web fallback has no HealthKit or Health Connect access.",
      ),
      permissions: {
        sleep: false,
        biometrics: false,
      },
      reason: "Web fallback has no HealthKit or Health Connect access.",
    };
  }

  async requestPermissions(): Promise<MobileSignalsPermissionStatus> {
    return this.checkPermissions();
  }

  async openSettings(
    options: MobileSignalsOpenSettingsOptions = {},
  ): Promise<MobileSignalsOpenSettingsResult> {
    return {
      opened: false,
      target: options.target ?? "app",
      actualTarget: "app",
      reason: "Web fallback cannot open native device settings.",
    };
  }

  private emitSignal = async (reason: string): Promise<void> => {
    if (!this.monitoring) return;
    const snapshot = await buildSnapshot(reason);
    this.notifyListeners("signal", snapshot);
    this.notifyListeners("signal", buildHealthSnapshot(reason));
  };

  private attachListeners(): void {
    if (typeof document !== "undefined") {
      const handleVisibilityChange = (): void => {
        void this.emitSignal("visibilitychange");
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      this.cleanup.push(() =>
        document.removeEventListener(
          "visibilitychange",
          handleVisibilityChange,
        ),
      );
    }

    if (typeof window !== "undefined") {
      const handleFocus = (): void => {
        void this.emitSignal("focus");
      };
      const handleBlur = (): void => {
        void this.emitSignal("blur");
      };
      window.addEventListener("focus", handleFocus);
      window.addEventListener("blur", handleBlur);
      this.cleanup.push(() => window.removeEventListener("focus", handleFocus));
      this.cleanup.push(() => window.removeEventListener("blur", handleBlur));
    }
  }

  private clearListeners(): void {
    while (this.cleanup.length > 0) {
      const cleanup = this.cleanup.pop();
      cleanup?.();
    }
  }

  async startMonitoring(
    options: MobileSignalsStartOptions = {},
  ): Promise<MobileSignalsStartResult> {
    if (!this.monitoring) {
      this.monitoring = true;
      this.attachListeners();
    }

    const snapshot = await buildSnapshot("start");
    const healthSnapshot = buildHealthSnapshot("start");
    if (options.emitInitial ?? true) {
      this.notifyListeners("signal", snapshot);
      this.notifyListeners("signal", healthSnapshot);
    }
    return {
      enabled: this.monitoring,
      supported: true,
      platform: snapshot.platform,
      snapshot,
      healthSnapshot,
    };
  }

  async stopMonitoring(): Promise<MobileSignalsStopResult> {
    this.monitoring = false;
    this.clearListeners();
    return { stopped: true };
  }

  async getSnapshot(): Promise<MobileSignalsSnapshotResult> {
    const snapshot = await buildSnapshot("snapshot");
    return {
      supported: true,
      snapshot,
      healthSnapshot: buildHealthSnapshot("snapshot"),
    };
  }

  async scheduleBackgroundRefresh(): Promise<{
    scheduled: boolean;
    reason: string;
  }> {
    return {
      scheduled: false,
      reason: "Web fallback cannot schedule native background refresh tasks.",
    };
  }

  async cancelBackgroundRefresh(): Promise<{
    cancelled: boolean;
    reason: string;
  }> {
    return {
      cancelled: false,
      reason: "Web fallback has no native background refresh task to cancel.",
    };
  }
}

export const __internal = {
  buildScreenTimeStatus,
};
