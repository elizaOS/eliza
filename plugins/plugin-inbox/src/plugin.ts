/**
 * `inboxPlugin` definition — wires the cross-channel inbox surface into a
 * runtime: the INBOX umbrella action (with its INBOX_* subactions promoted to
 * top-level actions so they resolve wherever the plugin loads), the
 * INBOX_TRIAGE and CROSS_CHANNEL_CONTEXT providers, the triage HTTP routes, the
 * `app_inbox` drizzle schema, and the InboxMigrationService that copies rows
 * across from PA's `app_lifeops` on first boot. Depends on `@elizaos/plugin-sql`
 * for the runtime DB handle the schema registers against.
 */

import {
  ElizaError,
  OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  promoteSubactionsToActions,
  registerDirectActionRoutingRule,
} from "@elizaos/core";
import type { HttpPlugin as Plugin } from "@elizaos/host/protocol";
import { getDefaultTriageService } from "@elizaos/plugin-assistant";
import { inboxAction } from "./actions/inbox.ts";
import { inboxDbSchema } from "./db/schema.ts";
import { ManagedGmailAdapter } from "./inbox/managed-gmail-adapter.ts";
import { InboxMigrationService } from "./inbox/migration.ts";
import { crossChannelContextProvider } from "./providers/cross-channel-context.ts";
import { inboxTriageProvider } from "./providers/inbox-triage.ts";
import { inboxRoutes } from "./routes/inbox-routes.ts";

// Claim only a complete, direct read. Recipient, date and compound requests
// stay with the general planner, where their full filters remain available.
const mailReadPrefix =
  /^(?:what(?:['’]?s|\s+(?:is|was|are|were))|which(?:\s+(?:is|was|are|were))?|(?:please\s+)?(?:show(?:\s+me)?|find|list|read|check|look\s+up))\s+/iu;
const sentMailSubject =
  /^(?:(?:the|my|our)\s+)?(?:(?:latest|last|most\s+recent|recent|\d+)\s+)?(?:sent\s+(?:e-?mails?|mail)|(?:e-?mails?|mail)\s+(?:that\s+)?(?:i|we)\s+sent)[?.!]?$/iu;

function isSentMailRead(text: string): boolean {
  const request = text.trim();
  return (
    mailReadPrefix.test(request) &&
    sentMailSubject.test(request.replace(mailReadPrefix, ""))
  );
}

export const inboxPlugin: Plugin = {
  name: "@elizaos/plugin-inbox",
  description:
    "Unified cross-channel inbox triage with unresolved-item tracking. Hosts the INBOX umbrella action (list/search/summarize fan-out across email/Discord/Telegram/WhatsApp/X/Slack and similar non-SMS channels) and the inboxTriage provider, backed by the InboxService/InboxRepository triage back-end plus the aggregation domain in `inbox/aggregate.ts` (builders, request resolver, cached read-through InboxDomain). The legacy transport route `GET /api/lifeops/inbox` and the connector sources/cache tables stay in @elizaos/plugin-personal-assistant, which injects them through the aggregate seams and delegates the domain here. (Android SMS is handled by plugin-native-messages.)",
  dependencies: ["@elizaos/plugin-sql"],
  schema: inboxDbSchema,
  services: [InboxMigrationService],
  // The adapter verifies the live owner action for every read. It supports
  // standard MESSAGE reads and INBOX fan-out. Separate host settings admit
  // reviewed new sends and owner-scoped mailbox changes.
  init: async (_config, runtime) => {
    const gmail = new ManagedGmailAdapter();
    if (gmail.isAvailable()) {
      const registry = getDefaultTriageService();
      const existing = registry.getAdapter("gmail");
      if (existing && !(existing instanceof ManagedGmailAdapter))
        throw new ElizaError(
          "A Gmail source is already registered. Select one owner transport before starting the agent.",
          { code: "MANAGED_GMAIL_SOURCE_CONFLICT" },
        );
      registry.register(gmail);
      registerDirectActionRoutingRule(runtime, {
        id: "inbox.gmail.sent",
        actionNames: ["MESSAGE_SEARCH_INBOX"],
        replacesActionNames: ["MESSAGE", "MESSAGE_LIST_INBOX"],
        requiredActionTags: ["domain:messages", "capability:read"],
        contexts: ["email"],
        matches: isSentMailRead,
      });
    }
  },
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
  ].map((action) => ({
    ...action,
    disclosureGate: OWNER_EXCLUSIVE_DISCLOSURE_GATE,
  })),
  providers: [inboxTriageProvider, crossChannelContextProvider].map(
    (provider) => ({
      ...provider,
      disclosureGate: OWNER_EXCLUSIVE_DISCLOSURE_GATE,
      cacheStable: false,
    }),
  ),
  routes: inboxRoutes,
  views: [
    {
      id: "inbox",
      label: "Inbox",
      // Inbox data is owner-private (every action and provider above carries
      // the owner-exclusive disclosure gate). The view follows the Notes and
      // Calendar precedent, which also keeps a host's native Inbox navigable.
      roleGate: { minRole: "OWNER" },
      description: "Cross-channel inbox triage",
      icon: "Inbox",
      path: "/inbox",
      responseContext: {
        primaryContext: "messaging",
        secondaryContexts: ["email"],
      },
      // The shipped view is GUI-only. `modalities` is a plain literal here
      // (plugin.ts is not in the view bundle).
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "InboxView",
      tags: ["inbox", "triage", "communication", "email", "mail", "messages"],
      relatedActions: ["INBOX"],
      visibleInManager: true,
    },
  ],
};
export default inboxPlugin;
