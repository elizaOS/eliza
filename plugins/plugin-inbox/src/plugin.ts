/**
 * `inboxPlugin` definition — wires the cross-channel inbox surface into a
 * runtime: the INBOX umbrella action (with its INBOX_* subactions promoted to
 * top-level actions so they resolve wherever the plugin loads), the
 * INBOX_TRIAGE and CROSS_CHANNEL_CONTEXT providers, the triage HTTP routes, the
 * `app_inbox` drizzle schema, and the InboxMigrationService that copies rows
 * across from PA's `app_lifeops` on first boot. Depends on `@elizaos/plugin-sql`
 * for the runtime DB handle the schema registers against.
 */
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
  // The `triage` override sharpens the planner signal so a genuine triage
  // request ("triage my inbox", "what needs my attention") routes to
  // INBOX_TRIAGE — the `inbox_triage` optimized-prompt consumer — instead of
  // the list/summarize reads (#11383).
  actions: [
    ...promoteSubactionsToActions(inboxAction, {
      overrides: {
        triage: {
          description:
            "subaction = triage — run the AI triage classifier over new cross-channel messages (urgent / needs_reply / notify / info / ignore) and return the prioritized queue",
          descriptionCompressed:
            "INBOX_TRIAGE classify new messages urgent|needs_reply|notify|info|ignore -> prioritized queue",
          similes: ["TRIAGE_INBOX", "PRIORITIZE_INBOX", "CLASSIFY_INBOX"],
        },
      },
    }),
  ],
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
      relatedActions: ["INBOX"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default inboxPlugin;
