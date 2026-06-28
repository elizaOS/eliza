import { isElizaOS } from "@elizaos/ui";
import { registerDeviceSettingsApp } from "./components/device-settings-app";

if (isElizaOS()) {
  registerDeviceSettingsApp();
}
