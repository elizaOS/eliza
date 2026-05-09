/**
 * elizaOS runtime plugin for the Phone app: exposes the live PLACE_CALL action
 * and a read-only phoneCallLog provider for recent-calls context. The agent
 * Android adapter applies hosted-app session gating when this package's
 * `/plugin` export is registered.
 *
 * Also declares the Phone Companion (Capacitor pairing/chat-mirror surface)
 * via `app.navTabs`, so the app shell can resolve and mount it dynamically
 * when the companion bundle runs alongside the desktop UI.
 */

import type { Plugin } from "@elizaos/core";
import { placeCallAction } from "./actions/place-call";
import { phoneCallLogProvider } from "./providers/call-log";

const PHONE_APP_NAME = "@elizaos/app-phone";

export const appPhonePlugin: Plugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer + recent-calls context. PLACE_CALL is a " +
    "live action; recent calls are surfaced read-only via the phoneCallLog " +
    "provider. Actions apply only while the Phone app session is active. " +
    "Also hosts the Phone Companion (Capacitor pairing + remote-session) " +
    "surface.",
  actions: [placeCallAction],
  providers: [phoneCallLogProvider],
  app: {
    navTabs: [
      {
        id: "phone-companion",
        label: "Phone Companion",
        icon: "Smartphone",
        path: "/phone-companion",
        componentExport: "@elizaos/app-phone#PhoneCompanionApp",
      },
    ],
  },
};

export default appPhonePlugin;

export { placeCallAction } from "./actions/place-call";
export { phoneCallLogProvider } from "./providers/call-log";
