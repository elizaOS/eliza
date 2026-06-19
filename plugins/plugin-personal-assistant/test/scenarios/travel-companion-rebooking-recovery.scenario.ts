import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "travel-companion-rebooking-recovery",
  title: "Assistant recovers companion travel rebooking",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "family", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Travel Companion Rebooking Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-companion-delay",
      text: "My travel companion missed their connection. Find rebooking options, hotel fallback, bag status, visa constraints, and whether my itinerary should change.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "priority"],
      responseIncludesAny: ["rebooking", "hotel", "bag", "visa"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-travel-recovery",
      text: "Prepare a rebooking decision tree and airline message. Ask before changing either itinerary or sharing passport details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["decision tree", "airline", "itinerary", "passport"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
