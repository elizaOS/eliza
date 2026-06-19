import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "auction-bid-approval-window",
  title: "Assistant prepares a private auction bid approval window",
  domain: "executive.approvals",
  tags: ["lifeops", "executive-assistant", "approval", "money", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Auction Bid Approval Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-bid-context",
      text: "The private auction bid window opens in two hours. Gather estimate, premium, shipping, insurance, provenance notes, budget ceiling, and approval cutoff.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "approval"],
      responseIncludesAny: ["estimate", "insurance", "provenance", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-bid-controls",
      text: "Draft the approval request and a no-action reminder if I have not approved 20 minutes before the cutoff. Do not place the bid.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "approval"],
      responseIncludesAny: ["approval", "reminder", "cutoff", "bid"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
