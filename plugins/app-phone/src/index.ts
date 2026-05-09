/**
 * Public entry for @elizaos/app-phone.
 *
 * Two surfaces ship in this package:
 *  - The Android phone overlay (dialer, recent-calls, contacts pane) backed
 *    by `@elizaos/capacitor-phone`.
 *  - The Phone Companion — Capacitor pairing + chat-mirror + remote-session
 *    surface that runs alongside (or in place of) the desktop UI.
 *
 * Both surfaces are exported from the package barrel; hosts choose what they
 * render without importing package subpaths.
 */

export { placeCallAction } from "./actions/place-call.js";
export { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp.js";
export * from "./companion/index.js";
export * from "./companion/services/index.js";
export { PhoneAppView } from "./components/PhoneAppView.js";
export {
  PHONE_APP_NAME,
  phoneApp,
  registerPhoneApp,
} from "./components/phone-app.js";
export { appPhonePlugin, default } from "./plugin.js";
export { phoneCallLogProvider } from "./providers/call-log.js";
export * from "./register.js";
export * from "./register-companion-page.js";
export * from "./ui.js";
