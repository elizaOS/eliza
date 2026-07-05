/**
 * Type definitions for the @elizaos/capacitor-system bridge.
 *
 * The native side is implemented in Kotlin under
 * android/src/main/java/ai/eliza/plugins/system/SystemPlugin.kt and is
 * registered with Capacitor as `ElizaSystem`. It exposes Android
 * RoleManager status, system-settings shortcuts, screen-brightness, and
 * per-stream audio-volume control. The web fallback in `./web.ts` returns
 * safe read defaults for status/settings queries but throws for every
 * Android-only action (settings shortcuts, role requests, brightness/volume
 * writes) — callers must guard those with a platform check rather than
 * expect empty-data silence.
 */
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

export interface SystemPlugin {
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
  openWriteSettings(): Promise<void>;
  openDisplaySettings(): Promise<void>;
  openSoundSettings(): Promise<void>;
}
