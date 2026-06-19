import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "speaking-fee-collection-chase",
  title: "Assistant chases speaking fee collection",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "followup", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Speaking Fee Collection Chase",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-unpaid-fee",
      text: "The speaking fee from last month's event is unpaid. Pull contract terms, invoice, organizer thread, payment due date, and tax form status.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "priority"],
      responseIncludesAny: ["contract", "invoice", "organizer", "tax"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-collection-note",
      text: "Draft a polite collection note and escalation schedule. Ask before sending payment instructions or copying legal.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["collection", "escalation", "payment instructions", "legal"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
