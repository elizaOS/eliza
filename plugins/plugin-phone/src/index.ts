/**
 * Public entry for @elizaos/plugin-phone.
 *
 * Two surfaces ship in this package:
 *  - The dialer + recent-calls surface, authored once as the unified `phone`
 *    plugin view (PhoneView → PhoneSpatialView), backed by
 *    `@elizaos/capacitor-phone`.
 *  - The Phone Companion — Capacitor pairing + chat-mirror + remote-session
 *    surface that runs alongside (or in place of) the desktop UI.
 *
 * Both surfaces are exported from the package barrel; its `PhoneView` is the
 * raw embeddable dialer. Hosts that own page navigation load the framed
 * `PhonePage` through the `/ui`, signed-registration, or view-bundle ABI.
 */

export { PhoneCompanionApp } from "./companion/components/PhoneCompanionApp.js";
export * from "./companion/index.js";
export * from "./companion/services/index.js";
export { PhonePage } from "./components/PhonePage.js";
export { PhoneView } from "./components/PhoneView.js";
export { appPhonePlugin, default } from "./plugin.js";
export { phoneCallLogProvider } from "./providers/call-log.js";
export * from "./register.js";
export * from "./register-companion-page.js";
export * from "./twilio.js";
export * from "./ui.js";
