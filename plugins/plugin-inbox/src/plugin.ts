import type { Plugin } from "@elizaos/core";

import { inboxAction } from "./actions/inbox.ts";
import * as dbSchema from "./db/index.ts";
import { crossChannelContextProvider } from "./providers/cross-channel-context.ts";
import { inboxTriageProvider } from "./providers/inbox-triage.ts";

export const inboxPlugin: Plugin = {
  name: "@elizaos/plugin-inbox",
  description:
    "Unified cross-channel inbox triage with unresolved-item tracking, snooze, archive, and follow-up watcher. Drives the inbox-zero workflow across email/Discord/Telegram/WhatsApp/X/Slack and similar non-SMS channels. (Android SMS is handled by plugin-messages.)",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [inboxAction],
  providers: [inboxTriageProvider, crossChannelContextProvider],
  schema: dbSchema,
  views: [
    {
      id: "inbox",
      label: "Inbox",
      description: "Cross-channel inbox triage",
      icon: "Inbox",
      path: "/inbox",
      bundlePath: "dist/views/bundle.js",
      componentExport: "InboxView",
      tags: ["inbox", "triage", "communication", "email", "mail", "messages"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default inboxPlugin;
