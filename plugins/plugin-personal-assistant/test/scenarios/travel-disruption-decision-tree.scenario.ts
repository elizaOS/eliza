import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "travel-disruption-decision-tree",
  title: "Assistant builds a travel disruption decision tree before acting",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "calendar"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Travel Disruption Decision Tree",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-travel-decision-tree",
      text: "My flight is delayed. Build a decision tree for rebooking, hotel, ground transport, and which meetings need a note. Ask before changing anything.",
      plannerIncludesAny: ["PERSONAL_ASSISTANT", "calendar_action", "travel"],
      responseIncludesAny: ["decision", "rebook", "hotel", "approval"],
      plannerExcludes: ["owner_send_message"],
    },
    {
      kind: "message",
      name: "prioritize-meeting-notes",
      text: "Prioritize the notes by external VIP first, then anything with a contract deadline.",
      plannerIncludesAny: ["PRIORITIZE", "vip", "contract"],
      responseIncludesAny: ["VIP", "contract", "priority"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
  ],
});
