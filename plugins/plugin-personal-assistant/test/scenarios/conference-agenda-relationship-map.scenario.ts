import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "conference-agenda-relationship-map",
  title: "Assistant maps conference meetings by relationship value and travel pressure",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "calendar", "relationships"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Conference Agenda Relationship Map",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "rank-conference-meetings",
      text: "For the conference next month, rank meeting requests by relationship value, travel friction, and whether I owe them a follow-up.",
      plannerIncludesAny: ["CALENDAR", "ENTITY", "PRIORITIZE"],
      responseIncludesAny: ["relationship", "travel", "follow"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-meeting-plan",
      text: "Draft a meeting plan with accept, decline, and delegate buckets. Ask before sending any declines.",
      plannerIncludesAny: ["owner_send_message", "approval", "delegate"],
      responseIncludesAny: ["accept", "decline", "delegate"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
