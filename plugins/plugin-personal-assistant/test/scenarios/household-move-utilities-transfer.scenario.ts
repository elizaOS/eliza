import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "household-move-utilities-transfer",
  title: "Assistant coordinates a move checklist across utilities and vendors",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Move Utilities Transfer",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-move-checklist",
      text: "We're moving on the 18th. Build the utility transfer checklist, find account numbers in docs, and tell me what needs identity verification.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["utility", "account", "verification"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "schedule-transfer-reminders",
      text: "Schedule reminders for cutoff dates and draft vendor messages, but do not expose account numbers in chat.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "privacy"],
      responseIncludesAny: ["reminder", "draft", "account"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
