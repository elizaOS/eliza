import { WebPlugin } from "@capacitor/core";

import type {
  AndroidRoleName,
  AndroidRoleRequestResult,
  DefaultAppRole,
  DefaultAppStatus,
  DeviceSettingsStatus,
  FlashlightStatus,
  LauncherApp,
  SystemPlugin,
  SystemStatus,
  SystemVolumeStatus,
  SystemVolumeStream,
} from "./definitions";

const ANDROID_ROLES = new Set<AndroidRoleName>([
  "home",
  "dialer",
  "sms",
  "assistant",
]);

const VOLUME_STREAMS = new Set<SystemVolumeStream>([
  "music",
  "ring",
  "alarm",
  "notification",
  "system",
  "voiceCall",
]);

function validateRole(role: unknown): AndroidRoleName {
  if (typeof role !== "string" || !ANDROID_ROLES.has(role as AndroidRoleName)) {
    throw new Error("role must be one of home, dialer, sms, assistant");
  }
  return role as AndroidRoleName;
}

function validateVolumeStream(stream: unknown): SystemVolumeStream {
  if (
    typeof stream !== "string" ||
    !VOLUME_STREAMS.has(stream as SystemVolumeStream)
  ) {
    throw new Error(
      "stream must be one of music, ring, alarm, notification, system, voiceCall",
    );
  }
  return stream as SystemVolumeStream;
}

function validateDefaultRole(role: unknown): DefaultAppRole {
  if (role !== "dial") throw new Error("role must be dial");
  return role;
}

export class SystemWeb extends WebPlugin implements SystemPlugin {
  async listLauncherApps(): Promise<{ apps: LauncherApp[] }> {
    // A browser exposes no installed apps; an empty list is the honest answer.
    return { apps: [] };
  }

  async launchApp(options: { packageName: string }): Promise<void> {
    if (typeof options?.packageName !== "string" || !options.packageName) {
      throw new Error("Choose an installed app");
    }
    throw new Error("Launching installed apps is only available on Android.");
  }

  async resolveDefaultApp(options: {
    role: DefaultAppRole;
  }): Promise<DefaultAppStatus> {
    return { role: validateDefaultRole(options?.role), available: false };
  }

  async openDefaultApp(options: { role: DefaultAppRole }): Promise<void> {
    const role = validateDefaultRole(options?.role);
    throw new Error(`The default ${role} app is only available on Android.`);
  }

  async getStatus(): Promise<SystemStatus> {
    return {
      packageName: "web",
      roles: [],
    };
  }

  async openSettings(): Promise<void> {
    throw new Error("System settings are only available on Android.");
  }

  async openNetworkSettings(): Promise<void> {
    throw new Error("Network settings are only available on Android.");
  }

  async openWriteSettings(): Promise<void> {
    throw new Error("Write-settings permission is only available on Android.");
  }

  async openDisplaySettings(): Promise<void> {
    throw new Error("Display settings are only available on Android.");
  }

  async openSoundSettings(): Promise<void> {
    throw new Error("Sound settings are only available on Android.");
  }

  async requestRole(options: {
    role: AndroidRoleName;
  }): Promise<AndroidRoleRequestResult> {
    const role = validateRole(options?.role);
    throw new Error(`Android role ${role} is only available on Android.`);
  }

  async getDeviceSettings(): Promise<DeviceSettingsStatus> {
    return {
      brightness: 0.75,
      brightnessMode: "unknown",
      canWriteSettings: false,
      volumes: [
        { stream: "music", current: 7, max: 15 },
        { stream: "ring", current: 4, max: 7 },
        { stream: "alarm", current: 4, max: 7 },
        { stream: "notification", current: 4, max: 7 },
      ],
    };
  }

  async setScreenBrightness(_options: {
    brightness: number;
  }): Promise<DeviceSettingsStatus> {
    if (
      typeof _options?.brightness !== "number" ||
      !Number.isFinite(_options.brightness) ||
      _options.brightness < 0 ||
      _options.brightness > 1
    ) {
      throw new Error("brightness must be a number between 0 and 1");
    }
    throw new Error("Brightness control is only available on Android.");
  }

  async setVolume(options: {
    stream: SystemVolumeStream;
    volume: number;
    showUi?: boolean;
  }): Promise<SystemVolumeStatus> {
    const stream = validateVolumeStream(options?.stream);
    if (
      typeof options?.volume !== "number" ||
      !Number.isFinite(options.volume) ||
      !Number.isInteger(options.volume) ||
      options.volume < 0
    ) {
      throw new Error("volume must be a non-negative finite integer");
    }
    throw new Error(`${stream} volume control is only available on Android.`);
  }

  async setFlashlight(options: {
    enabled: boolean;
  }): Promise<FlashlightStatus> {
    if (typeof options?.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    throw new Error("Flashlight control is only available on Android.");
  }
}
