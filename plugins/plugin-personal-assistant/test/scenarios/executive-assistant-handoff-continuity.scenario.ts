import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "executive-assistant-handoff-continuity",
  title: "Assistant prepares executive assistant handoff continuity",
  domain: "executive.delegation",
  tags: ["lifeops", "executive-assistant", "delegation", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Executive Assistant Handoff Continuity",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-handoff",
      text: "My human EA is out next week. Build a continuity handoff from open loops, VIP preferences, approvals, travel holds, vendor contacts, and private constraints.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["open loops", "VIP", "approvals", "travel"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-handoff-brief",
      text: "Draft the handoff brief and coverage checklist. Ask before sharing private preferences or assigning anyone new owner authority.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["handoff", "checklist", "preferences", "authority"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
