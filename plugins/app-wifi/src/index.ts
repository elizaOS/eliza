/**
 * Public entry for @elizaos/app-wifi — Android-only Wi-Fi overlay.
 *
 * Wraps `@elizaos/capacitor-wifi` and exposes a simple scan + connect UI plus
 * a single SCAN_WIFI agent action. The app is only registered on Android via
 * the `register` subpath; other platforms intentionally skip registration so
 * the app does not appear in the catalog where it cannot function.
 */

export { WifiAppView } from "./components/WifiAppView";
export {
  registerWifiApp,
  WIFI_APP_NAME,
  wifiApp,
} from "./components/wifi-app";
export { appWifiPlugin, default } from "./plugin";
export { wifiNetworksProvider } from "./providers/networks";
export * from "./register";
export * from "./ui";
