/**
 * Side-effect entry point: registers the device-settings overlay app on
 * import. Guarded by `isElizaOS()` so plain web/dev builds that pull this
 * package in transitively don't register an Android-only overlay into a
 * shell that never asked for it.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerDeviceSettingsApp } from "./components/device-settings-app";

if (isElizaOS()) {
  registerDeviceSettingsApp();
}
