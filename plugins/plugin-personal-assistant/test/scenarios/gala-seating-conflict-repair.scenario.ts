import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "gala-seating-conflict-repair",
  title: "Assistant repairs gala seating conflict",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "family", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Gala Seating Conflict Repair",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-seating-conflict",
      text: "The gala seating chart put two people with a history together. Find the RSVP list, relationship context, organizer contact, alternate tables, and deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["RSVP", "relationship", "organizer", "alternate"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-diplomatic-note",
      text: "Draft a diplomatic organizer note with two seating options. Ask before revealing the relationship history or requesting a table change.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["organizer", "options", "relationship", "table change"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
