import { isElizaOS } from "@elizaos/ui";
import { registerDeviceSettingsApp } from "./components/device-settings-app";

export function registerApp(): void {
  if (isElizaOS()) {
    registerDeviceSettingsApp();
  }
}
