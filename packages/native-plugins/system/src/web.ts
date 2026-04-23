import { WebPlugin } from "@capacitor/core";

import type { SystemPlugin, SystemStatus } from "./definitions";

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
}
