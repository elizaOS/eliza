import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the `inbox_triage` LifeOps capability.
 *
 * The inbox triage classifier (`buildTriagePrompt` / `classifyMessages` in
 * `@elizaos/plugin-inbox`) turns the owner's cross-channel feed into a
 * structured triage decision. Its instruction body is the GEPA-optimizable
 * `inbox_triage` prompt: `INBOX_TRIAGE_INSTRUCTIONS` is the wired baseline that
 * `resolveOptimizedPromptForRuntime` swaps for a registered `inbox_triage`
 * artifact, and the model call is tagged with `purpose: "inbox_triage"` for
 * trajectory capture (see `triage-classifier.ts`).
 *
 * "Show me my inbox" / "summarize my inboxes" / "search every channel" intents
 * route to the `INBOX` umbrella action (subactions list / search / summarize in
 * `@elizaos/plugin-inbox/src/actions/inbox.ts`). This scenario asserts each
 * request reaches the INBOX action and adds a final selected-action check so a
 * regression in the wired prompt or the routing surfaces as a failing scenario.
 * It mirrors `calendar-extract-capability` but is scoped to the inbox-triage
 * capability.
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
      plannerIncludesAll: ["inbox_action", "list"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
    {
      kind: "message",
      name: "triage-summarize-inboxes",
      text: "Summarize all my inboxes for me.",
      plannerIncludesAll: ["inbox_action", "summarize"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
    {
      kind: "message",
      name: "triage-search-channels",
      text: "Search every channel for messages about the launch.",
      plannerIncludesAll: ["inbox_action", "search", "launch"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "inbox action selected for every triage turn",
      actionName: "INBOX",
    },
  ],
});
