import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "priority-triage-mixed-sources",
  title: "Priority triage ranks blockers across messages, tasks, and decisions",
  domain: "executive.prioritization",
  tags: ["lifeops", "executive-assistant", "prioritize", "inbox"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Priority Triage Mixed Sources",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "rank-cross-source-blockers",
      text: "Rank my open decisions across email, calendar conflicts, and todos. Put anything blocking other people above informational noise.",
      plannerIncludesAll: ["PRIORITIZE"],
      plannerIncludesAny: ["decision", "email", "calendar", "todos"],
      responseIncludesAny: ["block", "priority", "decision", "noise"],
      plannerExcludes: ["owner_send_message"],
    },
    {
      kind: "message",
      name: "convert-top-blocker",
      text: "Turn the top blocker into a follow-up I won't miss.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "OWNER_REMINDERS", "follow"],
      responseIncludesAny: ["follow", "reminder", "scheduled"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
  ],
});
