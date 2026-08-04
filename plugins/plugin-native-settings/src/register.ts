import { isElizaOS } from "@elizaos/ui/platform/init";
import { registerDeviceSettingsApp } from "./components/device-settings-app";

if (isElizaOS()) {
  registerDeviceSettingsApp();
}
