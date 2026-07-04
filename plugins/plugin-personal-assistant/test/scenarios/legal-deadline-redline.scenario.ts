/**
 * Live-model scenario: the assistant triages vendor contract redlines and summarizes risky clauses while preserving the approval gate (nothing sent to counsel), then schedules a 4pm deadline reminder for the riskiest clause.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "legal-deadline-redline",
  title: "Assistant triages contract redlines and preserves approval gates",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "documents", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Legal Deadline Redline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-contract-deadline",
      text: "Find the vendor contract redlines due tomorrow, summarize the risky clauses, and do not send anything to counsel until I approve.",
      plannerIncludesAll: ["OWNER_DOCUMENTS"],
      plannerIncludesAny: ["redline", "vendor", "risky", "approval"],
      responseIncludesAny: ["clause", "risk", "approval", "tomorrow"],
      plannerExcludes: ["owner_send_message"],
    },
    {
      kind: "message",
      name: "schedule-legal-followup",
      text: "If I don't decide by 4 PM, remind me with the single riskiest clause and the deadline.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "deadline", "clause"],
      responseIncludesAny: ["4 PM", "reminder", "riskiest", "deadline"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
