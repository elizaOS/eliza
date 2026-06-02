import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "major-event-guest-logistics",
  title: "Assistant coordinates high-stakes guest logistics with approval gates",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Major Event Guest Logistics",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "map-guest-logistics",
      text: "For the fundraiser next month, reconcile VIP arrivals, dietary notes, hotel blocks, and the seating plan. Flag anyone who needs a personal note from me.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "VIP"],
      responseIncludesAny: ["VIP", "dietary", "hotel", "seating"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "draft-vip-note-batch",
      text: "Draft personal notes for the three highest-priority guests, but keep every note in approval until I review tone.",
      plannerIncludesAny: ["owner_send_message", "approval", "priority"],
      responseIncludesAny: ["draft", "approval", "tone", "guest"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
