import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "home-repair-contractor-coordination",
  title: "Assistant coordinates contractor bids, access windows, and follow-up",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Home Repair Coordination",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "coordinate-contractor-bids",
      text: "Coordinate three contractor bids for the leak repair. Offer two windows next week, keep them from overlapping, and track who has insurance.",
      plannerIncludesAny: ["CALENDAR", "SCHEDULED_TASKS", "contractor"],
      responseIncludesAny: ["windows", "contractor", "insurance"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "prepare-access-instructions",
      text: "Draft a short access note for the selected contractor, but do not share the door code until I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["draft", "door code", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
