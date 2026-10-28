import type { PluginListenerHandle } from "@capacitor/core";

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

export type SystemVolumeStream =
  | "music"
  | "ring"
  | "alarm"
  | "notification"
  | "system"
  | "voiceCall";

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

export interface FlashlightStatus {
  available: boolean;
  enabled: boolean;
}

/**
 * System switch, network and power facts Android reported to an ordinary app. A key Android did
 * not answer is absent, which means unknown, never off. These are read-only: settings surfaces
 * show them and hand off to the matching Android page.
 */
export interface SystemFacts {
  wifiEnabled?: boolean;
  bluetoothEnabled?: boolean;
  airplaneMode?: boolean;
  locationEnabled?: boolean;
  mobileDataEnabled?: boolean;
  interruptionFilter?: "all" | "priority" | "alarms" | "none";
  adaptiveBrightness?: boolean;
  /** An active Wi-Fi transport proves Wi-Fi is on; no active transport never proves it is off. */
  wifiActive?: boolean;
  cellularActive?: boolean;
  internetValidated?: boolean;
  batteryPercent?: number;
  charging?: boolean;
  powerSave?: boolean;
}

/** Allowlisted Android settings pages (`SystemSettingsPages.PAGES`). */
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

/** `specific` is false when only a broader fallback page opened. Nothing was changed. */
export interface SystemSettingsPageResult {
  status: "opened";
  page: SystemSettingsPage;
  specific: boolean;
}

/** `opened` means Android accepted the request, not that the shade is on screen. */
export type NotificationShadeOutcome =
  | "opened"
  | "standalone"
  | "permission-missing"
  | "unsupported"
  | "not-in-front";

/** Android profile kind of a launcher entry outside the current user. */
export type LauncherProfile = "work" | "private" | "clone" | "other";

/**
 * One launcher activity other than the host. Identity is `packageName`,
 * `activityName` and `user`, never the label. `user` and `profile` are absent
 * for the current user. `icon` is a PNG data URL when requested.
 */
export interface LauncherApp {
  packageName: string;
  activityName: string;
  label: string;
  user?: string;
  profile?: LauncherProfile;
  /** Present for another profile: true while it is paused or not unlocked. */
  locked?: boolean;
  icon?: string;
}

/** Stable reasons a launch of a listed entry is refused (the rejection `code`). */
export type LauncherRefusalCode =
  | "not-installed"
  | "disabled"
  | "no-launcher"
  | "profile-locked"
  | "profile-unavailable";

/** The list may have changed; re-read it. `packageName` is absent for a profile or batch change. */
export interface LauncherAppsChange {
  reason:
    | "added"
    | "removed"
    | "changed"
    | "available"
    | "unavailable"
    | "suspended"
    | "unsuspended"
    | "profile";
  packageName?: string;
}

/** Default-handler roles a launcher hands off to without implementing them. */
export type DefaultAppRole = "dial";

/** A chooser (several handlers, none preferred) is available with no packageName. */
export interface DefaultAppStatus {
  role: DefaultAppRole;
  available: boolean;
  packageName?: string;
  label?: string;
  icon?: string;
}

/**
 * `setup.DeviceSetup.readiness()` JSON. Package lists contain only installed
 * packages from the host's supported sets. The `false` fields are permanent:
 * Android gives no nonprivileged proof of vault readiness and no silent
 * default change.
 */
export interface DeviceSetupReadiness {
  installedBrowsers: string[];
  configuredBrowserPackage: string;
  browserDispatchStatus:
    | "not-configured"
    | "not-installed"
    | "untrusted"
    | "unavailable"
    | "ready";
  browserObservationAvailable: false;
  installedPasswordManagers: string[];
  preferredBrowserPackage: string | null;
  preferredBrowserIsSupported: boolean;
  autofillProviderPackage: string | null;
  autofillProviderIsSupported: boolean;
  providerVaultReadinessKnown: false;
  canChangeDefaultsSilently: false;
}

/** `setup.DeviceSetup.Target` names. App targets require a host-listed package. */
export type DeviceSetupTarget =
  | "BROWSER_DEFAULTS"
  | "CREDENTIAL_PROVIDERS"
  | "BROWSER_APP"
  | "PASSWORD_MANAGER_APP"
  | "APP_DETAILS";

/** `setup.DeviceSetup.Outcome` names. `OPENED` means a screen was started, not that the user changed a setting. */
export type DeviceSetupOutcome =
  | "OPENED"
  | "UNSUPPORTED_BROWSER"
  | "UNSUPPORTED_PASSWORD_MANAGER"
  | "UNSUPPORTED_PACKAGE"
  | "UNAVAILABLE";

/**
 * Bridge shape for a host plugin that exposes the native-only
 * `setup.DeviceSetup` helper. `ElizaSystem` does not implement it; the host
 * registers its own plugin and passes the Java enum names unchanged.
 */
export interface DeviceSetup {
  readiness(): Promise<DeviceSetupReadiness>;
  open(options: {
    target: DeviceSetupTarget;
    packageName?: string;
  }): Promise<{ outcome: DeviceSetupOutcome }>;
}

export interface SystemPlugin {
  listLauncherApps(options?: {
    icons?: boolean;
  }): Promise<{ apps: LauncherApp[] }>;
  /**
   * Opens a listed entry. Pass `activityName` (and `user` for another profile)
   * to open exactly that entry; a stale entry rejects with a
   * {@link LauncherRefusalCode}. Without `activityName` the package's default
   * launcher activity for the current user opens.
   */
  launchApp(options: {
    packageName: string;
    activityName?: string;
    user?: string;
  }): Promise<void>;
  addListener(
    eventName: "launcherAppsChanged",
    listener: (change: LauncherAppsChange) => void,
  ): Promise<PluginListenerHandle>;
  resolveDefaultApp(options: {
    role: DefaultAppRole;
  }): Promise<DefaultAppStatus>;
  openDefaultApp(options: { role: DefaultAppRole }): Promise<void>;
  getStatus(): Promise<SystemStatus>;
  requestRole(options: {
    role: AndroidRoleName;
  }): Promise<AndroidRoleRequestResult>;
  openSettings(): Promise<void>;
  openNetworkSettings(): Promise<void>;
  getDeviceSettings(): Promise<DeviceSettingsStatus>;
  setScreenBrightness(options: {
    brightness: number;
  }): Promise<DeviceSettingsStatus>;
  setVolume(options: {
    stream: SystemVolumeStream;
    volume: number;
    showUi?: boolean;
  }): Promise<SystemVolumeStatus>;
  setFlashlight(options: { enabled: boolean }): Promise<FlashlightStatus>;
  openWriteSettings(): Promise<void>;
  openDisplaySettings(): Promise<void>;
  openSoundSettings(): Promise<void>;
  getSystemFacts(): Promise<SystemFacts>;
  openSettingsPage(options: {
    page: SystemSettingsPage;
  }): Promise<SystemSettingsPageResult>;
  openNotificationShade(): Promise<{ status: NotificationShadeOutcome }>;
}
