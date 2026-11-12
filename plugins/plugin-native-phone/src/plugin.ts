/**
 * elizaOS runtime plugin for the Phone app: exposes a read-only phoneCallLog
 * provider for recent-calls context. Outbound calls are owned by the canonical
 * VOICE_CALL action; the Android dialer implementation remains internal until
 * it is wired as a VOICE_CALL provider. The agent
 * Android adapter applies hosted-app session gating when this package's
 * `/plugin` export is registered.
 *
 * Serves `POST /api/messages/reply-draft` (`./routes/reply-draft-route.ts`),
 * the suggested-reply draft for the Messages composer.
 *
 * Also declares the Phone Companion (Capacitor pairing/chat-mirror surface)
 * via `app.navTabs`, so the app shell can resolve and mount it dynamically
 * when the companion bundle runs alongside the desktop UI.
 */

import type { HttpPlugin } from "@elizaos/host/protocol";
import { phoneCallLogProvider } from "./providers/call-log";
import { replyDraftRoute } from "./routes/reply-draft-route";
import { PHONE_VIEW_CAPABILITIES } from "./view-capabilities";

const PHONE_APP_NAME = "@elizaos/plugin-native-phone";

export const appPhonePlugin: HttpPlugin = {
  name: PHONE_APP_NAME,
  description:
    "Phone overlay: Android dialer + recent-calls context. Recent calls are " +
    "surfaced read-only via the phoneCallLog provider. Outbound call placement " +
    "routes through the canonical VOICE_CALL surface when a provider is wired. " +
    "Also hosts the Phone Companion (Capacitor pairing + remote-session) " +
    "surface.",
  // VOICE_CALL is still host-adapted by plugin-personal-assistant. Keep this
  // app plugin read-only until the Android dialer provider is wired.
  actions: [],
  providers: [phoneCallLogProvider],
  // Served here, not from plugin-native-messages, because the resident Android
  // agent loads this plugin and does not load the Messages one.
  routes: [replyDraftRoute],
  views: [
    // One shipped GUI declaration drawn from PhoneView. The modality enum is
    // retained in the contract for future alternate view entries.
    {
      id: "phone",
      label: "Phone",
      description: "Android dialer and recent-calls log",
      icon: "Phone",
      path: "/phone",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      capabilities: PHONE_VIEW_CAPABILITIES,
      roleGate: { minRole: "ADMIN" },
      componentExport: "PhoneView",
      tags: ["phone", "calls", "android"],
      responseContext: { primaryContext: "phone" },
      visibleInManager: true,
      desktopTabEnabled: true,
      nativeOs: true,
    },
  ],
  app: {
    navTabs: [
      {
        id: "phone-companion",
        label: "Phone Companion",
        icon: "Smartphone",
        path: "/phone-companion",
        tabAffinity: "phone-companion",
        componentExport: "@elizaos/plugin-native-phone#PhoneCompanionApp",
      },
    ],
  },
};

export default appPhonePlugin;

export { phoneCallLogProvider } from "./providers/call-log";
