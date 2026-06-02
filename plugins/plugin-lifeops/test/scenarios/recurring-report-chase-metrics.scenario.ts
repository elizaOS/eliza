import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "recurring-report-chase-metrics",
  title: "Assistant chases missing metrics for a recurring operating report",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "delegation", "briefing"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Recurring Report Chase Metrics",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "find-missing-report-inputs",
      text: "The Monday operating report is missing metrics from sales, support, and finance. Find owners and draft pings.",
      plannerIncludesAny: ["BRIEF", "ENTITY", "owner_send_message"],
      responseIncludesAny: ["sales", "support", "finance", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "install-recurring-chase",
      text: "Make this recurring: if any owner has not replied by Friday morning, nudge them and show me the blockers.",
      plannerIncludesAll: ["SCHEDULED_TASKS"],
      plannerIncludesAny: ["Friday", "nudge", "blockers"],
      responseIncludesAny: ["recurring", "Friday", "blockers"],
      plannerExcludes: ["calendar_action"],
    },
  ],
});
