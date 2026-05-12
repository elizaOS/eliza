import type { Plugin } from "@elizaos/core";

export const appDeviceSettingsPlugin: Plugin = {
  name: "@elizaos/app-device-settings",
  description:
    "Android Device Settings overlay: inspect roles and control brightness or volume through the native system bridge.",
};

export default appDeviceSettingsPlugin;
