import { WebPlugin } from "@capacitor/core";

import type {
  AndroidRoleName,
  AndroidRoleRequestResult,
  SystemPlugin,
  SystemStatus,
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

  async requestRole(options: {
    role: AndroidRoleName;
  }): Promise<AndroidRoleRequestResult> {
    throw new Error(
      `Android role ${options.role} is only available on Android.`,
    );
  }
}
