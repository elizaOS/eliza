import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "donor-pledge-payment-coordination",
  title: "Assistant coordinates donor pledge payment",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "philanthropy", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Donor Pledge Payment Coordination",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-pledge",
      text: "A nonprofit is asking about my pledge payment. Pull pledge agreement, payment schedule, recognition preference, tax receipt requirements, and wire instructions.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "privacy"],
      responseIncludesAny: ["pledge", "recognition", "tax receipt", "wire"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-nonprofit-reply",
      text: "Draft a nonprofit reply and payment approval packet. Ask before sending wire details, recognition preferences, or releasing funds.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["reply", "approval", "wire details", "funds"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
