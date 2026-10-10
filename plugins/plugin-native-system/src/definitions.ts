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

/** One launchable app other than the host; `icon` is a PNG data URL when requested. */
export interface LauncherApp {
  packageName: string;
  label: string;
  icon?: string;
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
  launchApp(options: { packageName: string }): Promise<void>;
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
