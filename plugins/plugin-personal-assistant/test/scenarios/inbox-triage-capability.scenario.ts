import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the cross-channel INBOX routing surface that fronts
 * the `inbox_triage` LifeOps capability.
 *
 * Routing reality (verified against the promoted-action registry):
 * `@elizaos/plugin-personal-assistant` registers the INBOX umbrella via
 * `promoteSubactionsToActions(inboxAction)`, so the planner sees the umbrella
 * `INBOX` plus per-subaction virtuals `INBOX_LIST` / `INBOX_SEARCH` /
 * `INBOX_SUMMARIZE` / `INBOX_TRIAGE` / ... . Each virtual injects the
 * discriminator (`"action":"list"` etc.) into the dispatched parameters, so
 * the planner-trace assertions below match either routing shape: the promoted
 * virtual name OR the umbrella with a structured `action` parameter.
 *
 * RESIDUAL (#8795) — this scenario does NOT execute the `inbox_triage`
 * classifier prompt. `classifyMessages` / `buildTriagePrompt`
 * (`plugins/plugin-inbox/src/inbox/triage-classifier.ts`, model calls tagged
 * `purpose: "inbox_triage"`) is reachable only through
 * `InboxService.triage(...)`, whose sole caller is
 * `POST /api/lifeops/inbox/triage` (`routes/inbox-routes.ts`, a ctx-style
 * `routeHandler` route the scenario API server cannot dispatch). Every
 * planner-reachable INBOX subaction bypasses it: `list`/`search`/`summarize`
 * read through the core MESSAGE triage service (recency merge, no LLM
 * classification) and `triage` reads already-persisted queue entries. Until a
 * planner subaction or a `handler`-style route invokes the classifier, the
 * `inbox_triage` prompt path cannot be exercised from this scenario — do not
 * fake it with looser assertions.
 *
 * What this scenario proves: cross-channel inbox intents route to the INBOX
 * surface with the specific subaction the request calls for (list / summarize
 * / search), and not to the per-channel MESSAGE umbrella or CALENDAR.
 */
export default scenario({
  lane: "live-only",
  id: "inbox-triage-capability",
  title: "Inbox triage capability routes requests to the INBOX action",
  domain: "inbox",
  tags: ["lifeops", "inbox", "inbox_triage", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Inbox Triage Capability",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-list-inbox",
      text: "Show me my inbox across every channel.",
      // Promoted virtual (INBOX_LIST) or umbrella INBOX with the injected
      // structured discriminator — both shapes carry "action":"list".
      plannerIncludesAll: [/\bINBOX_LIST\b|"action":"list"/],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
    {
      kind: "message",
      name: "triage-summarize-inboxes",
      text: "Summarize all my inboxes for me.",
      plannerIncludesAll: [/\bINBOX_SUMMARIZE\b|"action":"summarize"/],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
    {
      kind: "message",
      name: "triage-search-channels",
      text: "Search every channel for messages about the launch.",
      plannerIncludesAll: [/\bINBOX_SEARCH\b|"action":"search"/, "launch"],
      plannerExcludes: [/\bCALENDAR(_[A-Z_]+)?\b/, /\bMESSAGE(_[A-Z_]+)?\b/],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "inbox action selected for every triage turn",
      actionName: ["INBOX", "INBOX_LIST", "INBOX_SEARCH", "INBOX_SUMMARIZE"],
    },
  ],
});
