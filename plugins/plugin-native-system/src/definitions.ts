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
}
