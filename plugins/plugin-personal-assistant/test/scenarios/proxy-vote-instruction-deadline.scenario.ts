import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "proxy-vote-instruction-deadline",
  title: "Assistant protects proxy vote instruction deadline",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "legal", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Proxy Vote Instruction Deadline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-proxy-deadline",
      text: "I got a proxy vote package with a short deadline. Pull the ballot items, custodian portal steps, advisor recommendation, share count, and cut-off time.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["ballot", "custodian", "advisor", "cut-off"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-vote-instructions",
      text: "Prepare a vote instruction summary and advisor clarification draft, but do not submit a vote or message the custodian until I approve.",
      plannerIncludesAny: ["owner_send_message", "approval", "priority"],
      responseIncludesAny: ["instruction", "advisor", "submit", "approve"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
