import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "caregiver-shift-transition",
  title: "Assistant coordinates a caregiver shift transition",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "schedule", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Caregiver Shift Transition",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-caregiver-handoff",
      text: "The overnight caregiver called out. Find backup coverage, medication handoff notes, transportation constraints, and who in the family needs an update.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "privacy"],
      responseIncludesAny: ["backup", "handoff", "transportation", "family"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-caregiver-updates",
      text: "Draft updates to the backup caregiver and family group, but keep medical details limited to the assigned caregiver only.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["backup caregiver", "family", "medical details", "limited"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
