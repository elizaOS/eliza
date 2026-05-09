/**
 * Public entry for @elizaos/app-phone.
 *
 * Two surfaces ship in this package:
 *  - The Android phone overlay (dialer, recent-calls, contacts pane) backed
 *    by `@elizaos/capacitor-phone`.
 *  - The Phone Companion — Capacitor pairing + chat-mirror + remote-session
 *    surface that runs alongside (or in place of) the desktop UI.
 *
 * Subpath imports (`./companion`, `./register-companion-page`, etc.) keep
 * each surface's runtime cost optional for hosts that only need one.
 */

export { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp";
export { PhoneAppView } from "./components/PhoneAppView";
export {
  PHONE_APP_NAME,
  phoneApp,
  registerPhoneApp,
} from "./components/phone-app";
export { appPhonePlugin, default } from "./plugin";
export { placeCallAction } from "./actions/place-call";
export { phoneCallLogProvider } from "./providers/call-log";
