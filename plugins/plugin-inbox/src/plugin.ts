import { type Plugin, promoteSubactionsToActions } from "@elizaos/core";

import { inboxAction } from "./actions/inbox.ts";
import { inboxDbSchema } from "./db/schema.ts";
import { InboxMigrationService } from "./inbox/migration.ts";
import { crossChannelContextProvider } from "./providers/cross-channel-context.ts";
import { inboxTriageProvider } from "./providers/inbox-triage.ts";
import { inboxRoutes } from "./routes/inbox-routes.ts";

export const inboxPlugin: Plugin = {
  name: "@elizaos/plugin-inbox",
  description:
    "Unified cross-channel inbox triage with unresolved-item tracking. Hosts the INBOX umbrella action (list/search/summarize fan-out across email/Discord/Telegram/WhatsApp/X/Slack and similar non-SMS channels) and the inboxTriage provider, backed by the InboxService/InboxRepository triage back-end plus the aggregation domain in `inbox/aggregate.ts` (builders, request resolver, cached read-through InboxDomain). The legacy transport route `GET /api/lifeops/inbox` and the connector sources/cache tables stay in @elizaos/plugin-personal-assistant, which injects them through the aggregate seams and delegates the domain here. (Android SMS is handled by plugin-messages.)",
  dependencies: ["@elizaos/plugin-sql"],
  schema: inboxDbSchema,
  services: [InboxMigrationService],
  // Promote the INBOX_* subaction virtuals here so they exist wherever the
  // plugin loads (including standalone, without plugin-personal-assistant).
  actions: [...promoteSubactionsToActions(inboxAction)],
  providers: [inboxTriageProvider, crossChannelContextProvider],
  routes: inboxRoutes,
  views: [
    {
      id: "inbox",
      label: "Inbox",
      description: "Cross-channel inbox triage",
      icon: "Inbox",
      path: "/inbox",
      // ONE declaration → GUI + XR + TUI, all drawn from the single InboxView
      // spatial source. `modalities` is a plain literal here (plugin.ts is not
      // in the view bundle).
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "InboxView",
      tags: ["inbox", "triage", "communication", "email", "mail", "messages"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default inboxPlugin;
