/**
 * elizaOS runtime plugin for the Phone app: exposes a read-only phoneCallLog
 * provider for recent-calls context. Outbound calls are owned by the canonical
 * VOICE_CALL action; the Android dialer implementation remains internal until
 * it is wired as a VOICE_CALL provider. The agent
 * Android adapter applies hosted-app session gating when this package's
 * `/plugin` export is registered.
 *
 * Also declares the Phone Companion (Capacitor pairing/chat-mirror surface)
 * via `app.navTabs`, so the app shell can resolve and mount it dynamically
 * when the companion bundle runs alongside the desktop UI.
 */

import type { Plugin } from "@elizaos/core";
import { phoneCallLogProvider } from "./providers/call-log";

const PHONE_APP_NAME = "@elizaos/app-phone";

export const appPhonePlugin: Plugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer + recent-calls context. Recent calls are " +
    "surfaced read-only via the phoneCallLog provider. Outbound call placement " +
    "routes through the canonical VOICE_CALL surface when a provider is wired. " +
    "Also hosts the Phone Companion (Capacitor pairing + remote-session) " +
    "surface.",
  actions: [],
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

export { phoneCallLogProvider } from "./providers/call-log";
