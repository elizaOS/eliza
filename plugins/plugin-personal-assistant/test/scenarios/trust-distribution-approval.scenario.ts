import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "trust-distribution-approval",
  title: "Assistant stages trust distribution approval",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "legal", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Trust Distribution Approval",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-distribution",
      text: "A beneficiary requested a trust distribution. Pull trust terms, request history, tax note, trustee approval chain, liquidity impact, and response deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["trust", "beneficiary", "tax", "approval"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-trustee-packet",
      text: "Prepare a trustee approval packet and beneficiary response draft. Ask before approving, denying, or sharing financial details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["trustee", "beneficiary", "approving", "financial"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
