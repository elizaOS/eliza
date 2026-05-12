import { WebPlugin } from "@capacitor/core";

import type {
  AndroidRoleName,
  AndroidRoleRequestResult,
  DeviceSettingsStatus,
  SystemPlugin,
  SystemStatus,
  SystemVolumeStatus,
  SystemVolumeStream,
} from "./definitions";

export class SystemWeb extends WebPlugin implements SystemPlugin {
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
    throw new Error(
      `Android role ${options.role} is only available on Android.`,
    );
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
    throw new Error("Brightness control is only available on Android.");
  }

  async setVolume(options: {
    stream: SystemVolumeStream;
    volume: number;
    showUi?: boolean;
  }): Promise<SystemVolumeStatus> {
    throw new Error(
      `${options.stream} volume control is only available on Android.`,
    );
  }
}
