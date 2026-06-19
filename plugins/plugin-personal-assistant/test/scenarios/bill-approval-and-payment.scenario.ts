import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "bill-approval-and-payment",
  title: "Assistant surfaces a bill, requests approval, and records payment follow-up",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Bill Approval and Payment",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "surface-bill-for-approval",
      text: "Check whether any bills need my approval this week and tell me the riskiest one first.",
      plannerIncludesAll: ["OWNER_FINANCES"],
      plannerIncludesAny: ["bill", "approval", "risk", "this week"],
      responseIncludesAny: ["bill", "approval", "risk"],
      plannerExcludes: ["calendar_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "approve-payment-and-followup",
      text: "Approve paying the contractor invoice, but remind me tomorrow to verify the receipt posted.",
      plannerIncludesAny: ["OWNER_FINANCES", "SCHEDULED_TASKS", "invoice"],
      responseIncludesAny: ["approved", "receipt", "tomorrow", "reminder"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
