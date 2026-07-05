/** UI-only barrel (explicit extensions) for bundlers that need to exclude the `register.ts` side effect. */

export { DeviceSettingsAppView } from "./components/DeviceSettingsAppView.tsx";
export {
  DEVICE_SETTINGS_APP_NAME,
  deviceSettingsApp,
  registerDeviceSettingsApp,
} from "./components/device-settings-app.ts";
