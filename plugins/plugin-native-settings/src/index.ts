/** Public barrel: the overlay app descriptor, its view, and the bare `Plugin` object (no actions/providers). */

export { DeviceSettingsAppView } from "./components/DeviceSettingsAppView";
export {
  DEVICE_SETTINGS_APP_NAME,
  deviceSettingsApp,
  registerDeviceSettingsApp,
} from "./components/device-settings-app";
export { appDeviceSettingsPlugin, default } from "./plugin";
export * from "./register";
export * from "./ui";
