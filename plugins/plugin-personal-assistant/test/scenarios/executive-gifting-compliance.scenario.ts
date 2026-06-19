import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "executive-gifting-compliance",
  title: "Assistant checks executive gifting compliance",
  domain: "executive.approvals",
  tags: ["lifeops", "executive-assistant", "approvals", "money", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Executive Gifting Compliance",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "review-gift-policy",
      text: "Before sending holiday gifts, check recipient list, company gift policy, client restrictions, shipping addresses, and budget approval.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["recipient", "policy", "restrictions", "budget"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-gift-approval",
      text: "Prepare a gift approval matrix and vendor order draft. Ask before sharing addresses or placing any order.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["matrix", "vendor", "addresses", "order"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
