import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "regulatory-comment-deadline",
  title: "Assistant coordinates a regulatory comment deadline",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "schedule", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Regulatory Comment Deadline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-regulatory-calendar",
      text: "Track the regulator comment window: filing deadline, counsel draft owner, supporting exhibits, trade association position, and who needs pre-read.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "deadline"],
      responseIncludesAny: ["deadline", "counsel", "exhibits", "pre-read"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-comment-approval",
      text: "Prepare the approval route and a reminder 48 hours before filing. Do not submit or message the regulator without my explicit signoff.",
      plannerIncludesAny: ["approval", "SCHEDULED_TASKS", "owner_send_message"],
      responseIncludesAny: ["approval", "reminder", "filing", "signoff"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
