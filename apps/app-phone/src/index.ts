/**
 * Public entry for @elizaos/app-phone — Android-only phone overlay.
 *
 * The app wraps `@elizaos/capacitor-phone` and exposes a dialer, recent-calls
 * view, and an optional contacts pane (when `@elizaos/capacitor-contacts` is
 * available on device).
 */

export { appPhonePlugin, default } from "./plugin";
export {
  PHONE_APP_NAME,
  phoneApp,
  registerPhoneApp,
} from "./components/phone-app";
export { PhoneAppView } from "./components/PhoneAppView";
