/**
 * elizaOS runtime plugin for the Phone app — exposes PLACE_CALL and
 * READ_CALL_LOG actions, both gated to the Phone app's session.
 *
 * Also declares the Phone Companion (Capacitor pairing/chat-mirror surface)
 * via `app.navTabs`, so the app shell can resolve and mount it dynamically
 * when the companion bundle runs alongside the desktop UI.
 */

import type { Plugin } from "@elizaos/core";
import { placeCallAction } from "./actions/place-call";
import { readCallLogAction } from "./actions/read-call-log";

const PHONE_APP_NAME = "@elizaos/app-phone";

export const appPhonePlugin: Plugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer, recent-calls, and contact-driven calls. " +
    "Actions apply only while the Phone app session is active. Also hosts " +
    "the Phone Companion (Capacitor pairing + remote-session) surface.",
  actions: [placeCallAction, readCallLogAction],
  app: {
    navTabs: [
      {
        id: "phone-companion",
        label: "Phone Companion",
        icon: "Smartphone",
        path: "/phone-companion",
        componentExport: "@elizaos/app-phone/ui#PhoneCompanionApp",
      },
    ],
  },
};

export default appPhonePlugin;

export { placeCallAction } from "./actions/place-call";
export { readCallLogAction } from "./actions/read-call-log";
