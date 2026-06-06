import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "quarterly-tax-payment-runbook",
  title: "Assistant prepares a quarterly tax payment runbook with approval gates",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "approvals", "tax"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Quarterly Tax Payment Runbook",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-tax-payment-context",
      text: "Quarterly estimated taxes are due next week. Gather the accountant email, voucher, payment portal link, cash balance, and last quarter's confirmation.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "tax"],
      responseIncludesAny: ["accountant", "voucher", "portal", "confirmation"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "approval-gated-payment-runbook",
      text: "Make the payment runbook, but do not submit anything until I approve the amount and destination.",
      plannerIncludesAny: ["approval", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["approve", "amount", "destination", "runbook"],
      plannerExcludes: ["PAYMENT_SUBMITTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
