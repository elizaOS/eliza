import { WebPlugin } from "@capacitor/core";
import type {
  MobileSignalsHealthSnapshot,
  MobileSignalsPermissionStatus,
  MobileSignalsPlatform,
  MobileSignalsPlugin,
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
}
