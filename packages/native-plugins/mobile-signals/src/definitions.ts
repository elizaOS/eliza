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

export type MobileSignalsSettingsTarget =
  | "app"
  | "health"
  | "healthConnect"
  | "screenTime"
  | "usageAccess"
  | "notification"
  | "batteryOptimization"
  | "localNetwork"
  | "deviceSettings";

export type MobileSignalsSetupActionStatus =
  | "ready"
  | "needs-action"
  | "unavailable";

export interface MobileSignalsSetupAction {
  id:
    | "health_permissions"
    | "screen_time_authorization"
    | "android_usage_access"
    | "app_settings"
    | "notification_settings"
    | "battery_optimization"
    | "local_network";
  label: string;
  status: MobileSignalsSetupActionStatus;
  canRequest: boolean;
  canOpenSettings: boolean;
  settingsTarget: MobileSignalsSettingsTarget | null;
  reason: string | null;
}

export interface MobileSignalsOpenSettingsOptions {
  target?: MobileSignalsSettingsTarget;
}

export type MobileSignalsPermissionTarget = "all" | "health" | "screenTime";

export interface MobileSignalsRequestPermissionsOptions {
  target?: MobileSignalsPermissionTarget;
}

export interface MobileSignalsOpenSettingsResult {
  opened: boolean;
  target: MobileSignalsSettingsTarget;
  actualTarget: MobileSignalsSettingsTarget;
  reason: string | null;
}

export interface MobileSignalsScreenTimeStatus {
  supported: boolean;
  requirements: {
    entitlements: {
      familyControls: string;
    };
    frameworks: string[];
    deviceActivityReportExtension: boolean;
    deviceActivityMonitorExtension: boolean;
    android?: {
      usageStatsPermission: string;
      usageAccessSettingsAction: string;
    };
  };
  entitlements: {
    familyControls: boolean;
  };
  provisioning: {
    satisfied: boolean;
    inspected: "code-signature" | "not-inspectable";
    reason: string | null;
  };
  authorization: {
    status: "approved" | "denied" | "not-determined" | "unavailable";
    canRequest: boolean;
  };
  reportAvailable: boolean;
  coarseSummaryAvailable: boolean;
  thresholdEventsAvailable: boolean;
  rawUsageExportAvailable: false;
  android?: {
    usageAccessGranted: boolean;
    packageUsageStatsPermissionDeclared: boolean;
    canOpenUsageAccessSettings: boolean;
    foregroundEventsAvailable: boolean;
    totalTimeForegroundMs: number | null;
  };
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
  screenTime: MobileSignalsScreenTimeStatus;
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
  source: "mobile_device";
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

export interface MobileSignalsBackgroundRefreshResult {
  scheduled: boolean;
  identifier?: string;
  earliestBeginInSeconds?: number;
  reason?: string;
}

export interface MobileSignalsCancelBackgroundRefreshResult {
  cancelled: boolean;
  reason?: string;
}

export interface MobileSignalsPlugin {
  checkPermissions(): Promise<MobileSignalsPermissionStatus>;
  requestPermissions(
    options?: MobileSignalsRequestPermissionsOptions,
  ): Promise<MobileSignalsPermissionStatus>;
  openSettings(
    options?: MobileSignalsOpenSettingsOptions,
  ): Promise<MobileSignalsOpenSettingsResult>;
  startMonitoring(
    options?: MobileSignalsStartOptions,
  ): Promise<MobileSignalsStartResult>;
  stopMonitoring(): Promise<MobileSignalsStopResult>;
  getSnapshot(): Promise<MobileSignalsSnapshotResult>;
  scheduleBackgroundRefresh(): Promise<MobileSignalsBackgroundRefreshResult>;
  cancelBackgroundRefresh(): Promise<MobileSignalsCancelBackgroundRefreshResult>;
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
  screenTime: MobileSignalsScreenTimeStatus;
  setupActions: MobileSignalsSetupAction[];
  permissions: {
    sleep: boolean;
    biometrics: boolean;
  };
}
