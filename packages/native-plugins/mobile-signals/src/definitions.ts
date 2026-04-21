import type { PluginListenerHandle } from "@capacitor/core";

export type MobileSignalsPlatform = "android" | "ios" | "web";

export type MobileSignalsSource = "mobile_device" | "mobile_health";

export type MobileSignalsState =
  | "active"
  | "idle"
  | "background"
  | "locked"
  | "sleeping";

export type MobileSignalsHealthSource = "healthkit" | "health_connect";

export interface MobileSignalsScreenTimeStatus {
  supported: boolean;
  entitlements: {
    familyControls: boolean;
    appAndWebsiteUsage: boolean;
  };
  authorization: {
    status: "approved" | "denied" | "not-determined" | "unavailable";
    canRequest: boolean;
  };
  reportAvailable: boolean;
  coarseSummaryAvailable: boolean;
  thresholdEventsAvailable: boolean;
  rawUsageExportAvailable: false;
  reason: string | null;
}

export interface MobileSignalsHealthSleepSnapshot {
  available: boolean;
  isSleeping: boolean;
  asleepAt: number | null;
  awakeAt: number | null;
  durationMinutes: number | null;
  stage: string | null;
}

export interface MobileSignalsHealthBiometricSnapshot {
  sampleAt: number | null;
  heartRateBpm: number | null;
  restingHeartRateBpm: number | null;
  heartRateVariabilityMs: number | null;
  respiratoryRate: number | null;
  bloodOxygenPercent: number | null;
}

export interface MobileSignalsHealthSnapshot {
  source: "mobile_health";
  platform: MobileSignalsPlatform;
  state: "idle" | "sleeping";
  observedAt: number;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  healthSource: MobileSignalsHealthSource;
  screenTime?: MobileSignalsScreenTimeStatus;
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
  sleep: MobileSignalsHealthSleepSnapshot;
  biometrics: MobileSignalsHealthBiometricSnapshot;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface MobileSignalsSnapshot {
  source: MobileSignalsSource;
  platform: MobileSignalsPlatform;
  state: MobileSignalsState;
  observedAt: number;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  metadata: Record<string, unknown>;
}

export type MobileSignalsSignal =
  | MobileSignalsSnapshot
  | MobileSignalsHealthSnapshot;

export interface MobileSignalsStartOptions {
  emitInitial?: boolean;
}

export interface MobileSignalsStartResult {
  enabled: boolean;
  supported: boolean;
  platform: MobileSignalsPlatform;
  snapshot: MobileSignalsSnapshot | null;
  healthSnapshot: MobileSignalsHealthSnapshot | null;
}

export interface MobileSignalsStopResult {
  stopped: boolean;
}

export interface MobileSignalsSnapshotResult {
  supported: boolean;
  snapshot: MobileSignalsSnapshot | null;
  healthSnapshot: MobileSignalsHealthSnapshot | null;
}

export interface MobileSignalsPlugin {
  checkPermissions(): Promise<MobileSignalsPermissionStatus>;
  requestPermissions(): Promise<MobileSignalsPermissionStatus>;
  startMonitoring(
    options?: MobileSignalsStartOptions,
  ): Promise<MobileSignalsStartResult>;
  stopMonitoring(): Promise<MobileSignalsStopResult>;
  getSnapshot(): Promise<MobileSignalsSnapshotResult>;
  addListener(
    eventName: "signal",
    listenerFunc: (event: MobileSignalsSignal) => void,
  ): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

export interface MobileSignalsPermissionStatus {
  status: "granted" | "denied" | "not-determined" | "not-applicable";
  canRequest: boolean;
  reason?: string;
  screenTime?: MobileSignalsScreenTimeStatus;
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
}
