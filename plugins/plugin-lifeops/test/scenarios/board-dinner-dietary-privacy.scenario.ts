import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-dinner-dietary-privacy",
  title: "Assistant coordinates board dinner dietary privacy",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "privacy", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Dinner Dietary Privacy",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-dinner-needs",
      text: "For the board dinner, gather dietary restrictions, guest list, seating sensitivities, restaurant contact, deposit deadline, and privacy constraints.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["dietary", "guest list", "restaurant", "privacy"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-restaurant-note",
      text: "Draft the restaurant note and guest confirmation. Ask before sharing medical dietary details or finalizing the deposit.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["restaurant", "guest", "medical", "deposit"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
