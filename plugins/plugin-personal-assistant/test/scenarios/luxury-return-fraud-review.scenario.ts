import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "luxury-return-fraud-review",
  title: "Assistant reviews luxury return fraud risk",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "vendor", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Luxury Return Fraud Review",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-return",
      text: "A luxury return was denied as suspected fraud. Pull receipt, shipping proof, card charge, boutique thread, return policy, and escalation contacts.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "priority"],
      responseIncludesAny: ["receipt", "shipping", "policy", "escalation"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-return-escalation",
      text: "Draft a boutique escalation and card dispute packet. Ask before filing a dispute or sharing identity documents.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["escalation", "dispute", "identity", "documents"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
