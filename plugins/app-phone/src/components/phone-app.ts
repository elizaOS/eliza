/**
 * Phone overlay app definition + registration.
 *
 * Registered by the phone side-effect entry only on Android;
 * other platforms intentionally skip registration so the app does not appear
 * in the catalog where it cannot function.
 */

import { type OverlayApp, registerOverlayApp } from "@elizaos/ui";
import { PhoneAppView } from "./PhoneAppView";

export const PHONE_APP_NAME = "@elizaos/app-phone";

export const phoneApp: OverlayApp = {
  name: PHONE_APP_NAME,
  displayName: "Phone",
  description: "Dialer, recent calls, and contact calling for Android",
  category: "system",
  icon: null,
  androidOnly: true,
  Component: PhoneAppView,
};

/** Register the Phone app with the overlay app registry. */
export function registerPhoneApp(): void {
  registerOverlayApp(phoneApp);
}
