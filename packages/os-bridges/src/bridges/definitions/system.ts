// spec/os/android/system.md, "Story: Hand me to Android's own screens and apps"; spec/os/android/system.md, "Story: Report device facts honestly"; spec/os/android/system.md, "Story: Change volume, mute or brightness and see what Android applied"; spec/os/android/system.md, "Story: Ask for a default role"; spec/os/android/home.md, "Story: Show my apps and open the one I chose"
import type { PluginListenerHandle } from "@capacitor/core";
import type { HandoffOutcome } from "../../../gen/os__android__bridge.ts";

export type AndroidRoleName = "home" | "dialer" | "sms" | "assistant";

export interface AndroidRoleStatus {
  role: AndroidRoleName;
  androidRole: string;
  held: boolean;
  holders: string[];
  available: boolean;
}

export interface SystemStatus {
  packageName: string;
  roles: AndroidRoleStatus[];
}

export interface AndroidRoleRequestResult {
  role: AndroidRoleName;
  held: boolean;
  resultCode: number;
}

export type RoleAnswer = "held" | "not-held" | "not-offered" | "unavailable";

export interface RoleRequestReport {
  role: AndroidRoleName;
  answer: RoleAnswer;
}

export type SystemVolumeStream = "music" | "ring" | "alarm" | "notification" | "system" | "voiceCall";

export interface SystemVolumeStatus {
  stream: SystemVolumeStream;
  current: number;
  max: number;
}

export interface DeviceSettingsStatus {
  brightness: number;
  brightnessMode: "manual" | "automatic" | "unknown";
  canWriteSettings: boolean;
  volumes: SystemVolumeStatus[];
}

export type ControlReading =
  | { kind: "reported"; level: number }
  | { kind: "unknown" }
  | { kind: "failed" }
  | { kind: "not-allowed" };

export type SwitchState = "on" | "off" | "unknown";

export interface VolumeChange {
  stream: SystemVolumeStream;
  reading: ControlReading;
  muted: SwitchState;
}

export interface BrightnessChange {
  reading: ControlReading;
}

export interface FlashlightStatus {
  available: boolean;
  enabled: boolean;
}

export type InterruptionFilter = "all" | "priority" | "alarms" | "none";

export interface SystemFacts {
  wifiEnabled?: boolean;
  bluetoothEnabled?: boolean;
  airplaneMode?: boolean;
  locationEnabled?: boolean;
  mobileDataEnabled?: boolean;
  interruptionFilter?: InterruptionFilter;
  adaptiveBrightness?: boolean;
  wifiActive?: boolean;
  cellularActive?: boolean;
  internetValidated?: boolean;
  batteryPercent?: number;
  charging?: boolean;
  powerSave?: boolean;
}

export type SystemSwitch =
  | "wifiEnabled"
  | "bluetoothEnabled"
  | "airplaneMode"
  | "locationEnabled"
  | "mobileDataEnabled"
  | "adaptiveBrightness"
  | "wifiActive"
  | "cellularActive"
  | "internetValidated"
  | "charging"
  | "powerSave";

export type SystemSwitchStates = Record<SystemSwitch, SwitchState>;

export type SystemSettingsPage =
  | "accounts"
  | "wifi"
  | "bluetooth"
  | "mobile"
  | "airplane"
  | "location"
  | "display"
  | "sound"
  | "battery"
  | "about"
  | "developer"
  | "notifications"
  | "privacy"
  | "default-apps"
  | "dnd";

export interface SystemSettingsPageResult {
  status: "opened";
  page: SystemSettingsPage;
  specific: boolean;
}

export interface SettingsHandoff {
  outcome: HandoffOutcome;
  page: SystemSettingsPage | "home" | "write-settings";
  specific: boolean;
}

export type NotificationShadeOutcome = "opened" | "standalone" | "permission-missing" | "unsupported" | "not-in-front";

export interface ShadeHandoff {
  outcome: HandoffOutcome;
  status: NotificationShadeOutcome;
}

export type LauncherProfile = "work" | "private" | "clone" | "other";

export interface LauncherApp {
  packageName: string;
  activityName: string;
  label: string;
  user?: string;
  profile?: LauncherProfile;
  locked?: boolean;
  icon?: string;
}

export type InstalledApp = Omit<LauncherApp, "activityName"> & { activityName?: string };

export type LauncherRefusalCode = "not-installed" | "disabled" | "no-launcher" | "profile-locked" | "profile-unavailable" | "failed";

export interface LauncherAppsChange {
  reason: "added" | "removed" | "changed" | "available" | "unavailable" | "suspended" | "unsuspended" | "profile";
  packageName?: string;
}

export type DefaultAppRole = "dial";

export interface DefaultAppStatus {
  role: DefaultAppRole;
  available: boolean;
  packageName?: string;
  label?: string;
  icon?: string;
}

export interface SystemBuildInfo {
  launcher: boolean;
  version: string;
}

export interface SystemLaunchInfo {
  assistant: boolean;
}

export interface SystemLocaleInfo {
  locale: string;
  hour24: boolean;
}

export interface LaunchTarget {
  packageName: string;
  activityName?: string;
  user?: string;
}

export interface SystemPlugin {
  listLauncherApps(options?: { icons?: boolean }): Promise<{ apps: LauncherApp[] }>;
  launchApp(options: LaunchTarget): Promise<void>;
  addListener(eventName: "launcherAppsChanged", listener: (change: LauncherAppsChange) => void): Promise<PluginListenerHandle>;
  resolveDefaultApp(options: { role: DefaultAppRole }): Promise<DefaultAppStatus>;
  openDefaultApp(options: { role: DefaultAppRole }): Promise<void>;
  getStatus(): Promise<SystemStatus>;
  requestRole(options: { role: AndroidRoleName }): Promise<AndroidRoleRequestResult>;
  openSettings(): Promise<void>;
  openNetworkSettings(): Promise<void>;
  getDeviceSettings(): Promise<DeviceSettingsStatus>;
  setScreenBrightness(options: { brightness: number }): Promise<DeviceSettingsStatus>;
  setVolume(options: { stream: SystemVolumeStream; volume: number; showUi?: boolean }): Promise<SystemVolumeStatus>;
  setFlashlight(options: { enabled: boolean }): Promise<FlashlightStatus>;
  openWriteSettings(): Promise<void>;
  openDisplaySettings(): Promise<void>;
  openSoundSettings(): Promise<void>;
  getSystemFacts(): Promise<SystemFacts>;
  openSettingsPage(options: { page: SystemSettingsPage }): Promise<SystemSettingsPageResult>;
  openNotificationShade(): Promise<{ status: NotificationShadeOutcome }>;
  getBuildInfo(): Promise<SystemBuildInfo>;
  getLaunchInfo(): Promise<SystemLaunchInfo>;
  getLocaleInfo(): Promise<SystemLocaleInfo>;
}

export type AppInfoRefusal = "invalid" | "profile-unavailable" | "not-installed" | "failed";

export interface AppInfoHandoff {
  outcome: HandoffOutcome;
  refusal?: AppInfoRefusal;
}

export type ClockRequest =
  | { action: "set"; hour: number; minute: number; label: string; days?: number[] }
  | { action: "show" }
  | { action: "dismiss" }
  | { action: "snooze"; minutes: number };

export type ClockStatus = "opened" | "unavailable" | "denied" | "failed" | "unknown";

export interface ClockReply {
  action: ClockRequest["action"];
  status: ClockStatus;
  message: string;
  receiver?: string;
}

export interface ClockHandoff {
  outcome: HandoffOutcome;
  status: ClockStatus;
  message: string;
}

export type NativeCrashSource = "uncaught" | "exit" | "renderer";
export type RendererFailureKind = "render" | "startup" | "uncaught";
export type CrashExitReason =
  | "crash"
  | "native-crash"
  | "anr"
  | "low-memory"
  | "signaled"
  | "initialization-failure"
  | "excessive-resource-usage"
  | "dependency-died"
  | "freezer"
  | "other"
  | "unknown"
  | "exit-self";

export interface NativeCrashEntry {
  at: number;
  source: NativeCrashSource;
  kind?: RendererFailureKind;
  errorClass?: string;
  rootClass?: string;
  reason?: CrashExitReason;
  process?: string;
  thread?: "main" | "background";
}

export interface CrashLogRead {
  entries: NativeCrashEntry[];
  exitHistory: boolean;
}

export interface SystemHostPlugin {
  openAppInfo(options: LaunchTarget): Promise<void>;
  openClock(options: ClockRequest): Promise<ClockReply>;
  crashLog(): Promise<{ entries?: unknown; exitHistory?: unknown }>;
  recordRendererFailure(options: { kind: RendererFailureKind; errorClass: string }): Promise<void>;
  clearCrashLog(): Promise<void>;
}

export interface DeviceSetupReadiness {
  installedBrowsers: string[];
  configuredBrowserPackage: string;
  browserDispatchStatus: "not-configured" | "not-installed" | "untrusted" | "unavailable" | "ready";
  browserObservationAvailable: false;
  installedPasswordManagers: string[];
  preferredBrowserPackage: string | null;
  preferredBrowserIsSupported: boolean;
  autofillProviderPackage: string | null;
  autofillProviderIsSupported: boolean;
  providerVaultReadinessKnown: false;
  canChangeDefaultsSilently: false;
}

export type DeviceSetupTarget = "BROWSER_DEFAULTS" | "CREDENTIAL_PROVIDERS" | "BROWSER_APP" | "PASSWORD_MANAGER_APP" | "APP_DETAILS";

export type DeviceSetupOutcome = "OPENED" | "UNSUPPORTED_BROWSER" | "UNSUPPORTED_PASSWORD_MANAGER" | "UNSUPPORTED_PACKAGE" | "UNAVAILABLE";

export interface DeviceSetup {
  readiness(): Promise<DeviceSetupReadiness>;
  open(options: { target: DeviceSetupTarget; packageName?: string }): Promise<{ outcome: DeviceSetupOutcome }>;
}

export interface DeviceSetupHandoff {
  outcome: HandoffOutcome;
  status: DeviceSetupOutcome;
}

export interface SystemClient
  extends Omit<
    SystemPlugin,
    | "requestRole"
    | "openSettings"
    | "openNetworkSettings"
    | "openWriteSettings"
    | "openDisplaySettings"
    | "openSoundSettings"
    | "openSettingsPage"
    | "openNotificationShade"
    | "openDefaultApp"
    | "setVolume"
    | "setScreenBrightness"
  > {
  requestRole(options: { role: AndroidRoleName }): Promise<RoleRequestReport>;
  openSettings(): Promise<SettingsHandoff>;
  openNetworkSettings(): Promise<SettingsHandoff>;
  openWriteSettings(): Promise<SettingsHandoff>;
  openDisplaySettings(): Promise<SettingsHandoff>;
  openSoundSettings(): Promise<SettingsHandoff>;
  openSettingsPage(options: { page: SystemSettingsPage }): Promise<SettingsHandoff>;
  openNotificationShade(): Promise<ShadeHandoff>;
  openDefaultApp(options: { role: DefaultAppRole }): Promise<HandoffOutcome>;
  setVolume(options: { stream: SystemVolumeStream; volume: number; showUi?: boolean }): Promise<VolumeChange>;
  mute(options: { stream: SystemVolumeStream }): Promise<VolumeChange>;
  setScreenBrightness(options: { brightness: number }): Promise<BrightnessChange>;
  switchStates(): Promise<SystemSwitchStates>;
  openAppInfo(options: LaunchTarget): Promise<AppInfoHandoff>;
  openClock(options: ClockRequest): Promise<ClockHandoff>;
  crashLog(): Promise<CrashLogRead>;
  recordRendererFailure(options: { kind: RendererFailureKind; errorClass: string }): Promise<void>;
  clearCrashLog(): Promise<void>;
}

export interface LauncherBridge {
  list(options?: { icons?: boolean }): Promise<{ apps: InstalledApp[] }>;
  launch(options: LaunchTarget): Promise<void>;
  resolveDefault?(options: { role: "dial" }): Promise<DefaultAppStatus>;
  openDefault?(options: { role: "dial" }): Promise<void>;
  addListener?(event: "appsChanged", listener: (change: LauncherAppsChange) => void): Promise<PluginListenerHandle>;
}

export type SystemLauncherPlugin = Pick<SystemPlugin, "listLauncherApps" | "launchApp" | "resolveDefaultApp" | "openDefaultApp" | "addListener">;

export type LauncherStatus = "idle" | "loading" | "ready" | "failed";

export type LauncherError =
  | { kind: "no-longer-installed"; label: string }
  | { kind: "app-refused"; label: string; code?: LauncherRefusalCode }
  | { kind: "dial-refused"; label: string };

export interface BuiltinView {
  key: string;
  label: string;
  admitted: boolean;
}

export interface LauncherSnapshot {
  status: LauncherStatus;
  apps: InstalledApp[];
  views: BuiltinView[];
  dial: DefaultAppStatus | null;
  launching: string | null;
  launchError: LauncherError | null;
}

export interface Launcher {
  snapshot(): LauncherSnapshot;
  show(): Promise<LauncherSnapshot>;
  load(): Promise<LauncherSnapshot>;
  refresh(signal: "packages-changed" | "resumed" | "hidden"): Promise<LauncherSnapshot>;
  launch(app: InstalledApp): Promise<LauncherSnapshot>;
  openView(view: BuiltinView): Promise<boolean>;
  openDial(): Promise<LauncherSnapshot>;
  clearError(): Promise<LauncherSnapshot>;
  retire(): Promise<void>;
}
