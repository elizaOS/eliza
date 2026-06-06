import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "complex-travel-reimbursement",
  title: "Assistant prepares complex travel reimbursement",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "travel", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Complex Travel Reimbursement",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-reimbursement-packet",
      text: "Prepare reimbursement for the Asia trip: split personal versus company expenses, missing hotel folios, FX rates, client dinner attendees, and finance approver.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "travel"],
      responseIncludesAny: ["personal", "hotel", "FX", "approver"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-expense-submission",
      text: "Draft the expense packet summary and questions for finance. Ask me before submitting any reimbursement or charging the corporate card.",
      plannerIncludesAny: ["owner_send_message", "approval", "OWNER_FINANCES"],
      responseIncludesAny: ["summary", "finance", "submitting", "corporate card"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
