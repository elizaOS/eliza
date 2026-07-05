/**
 * Bare `Plugin` descriptor (name + description only, no actions/providers/
 * services) — the elizaOS-recognizable identity for the device-settings
 * overlay app. All actual behavior is delivered through the `OverlayApp`
 * registered by `./components/device-settings-app.ts`, not through this object.
 */

import type { Plugin } from "@elizaos/core";

export const appDeviceSettingsPlugin: Plugin = {
  name: "@elizaos/plugin-native-settings",
  description:
    "Android Device Settings overlay: inspect roles and control brightness or volume through the native system bridge.",
};

export default appDeviceSettingsPlugin;
