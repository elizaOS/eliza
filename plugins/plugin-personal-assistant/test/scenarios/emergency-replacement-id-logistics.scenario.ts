import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "emergency-replacement-id-logistics",
  title: "Assistant coordinates emergency replacement ID logistics",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Emergency Replacement ID Logistics",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-lost-id",
      text: "My wallet with ID was lost before tomorrow's flight. Find replacement ID options, TSA fallback, police report steps, card freezes, and itinerary risk.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "priority"],
      responseIncludesAny: ["replacement", "TSA", "police report", "card freezes"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-id-recovery",
      text: "Prepare an ID recovery checklist and airline message. Ask before sharing identity documents or changing the flight.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["checklist", "airline", "identity", "flight"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
