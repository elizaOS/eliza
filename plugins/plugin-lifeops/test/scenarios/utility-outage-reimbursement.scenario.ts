import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "utility-outage-reimbursement",
  title: "Assistant coordinates utility outage reimbursement",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "vendor", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Utility Outage Reimbursement",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-outage-claim",
      text: "The power outage damaged refrigerated medicine and food. Pull utility claim rules, receipts, outage timestamps, insurance overlap, and filing deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["claim", "receipts", "timestamps", "deadline"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-claim",
      text: "Prepare the reimbursement claim and insurer question list. Ask before filing or sharing any medical details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["reimbursement", "insurer", "filing", "medical"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
