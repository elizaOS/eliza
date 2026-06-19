import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "founder-equity-admin-window",
  title: "Assistant coordinates founder equity admin window",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Founder Equity Admin Window",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-equity-admin",
      text: "Prepare the founder equity admin window: 83(b) docs, transfer restrictions, board consent status, tax advisor availability, and signature deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "deadline"],
      responseIncludesAny: ["83(b)", "transfer", "board consent", "deadline"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-equity-signoff",
      text: "Draft the signoff checklist for counsel and tax advisor. Ask me before sending documents or authorizing any filing fee.",
      plannerIncludesAny: ["owner_send_message", "approval", "OWNER_DOCUMENTS"],
      responseIncludesAny: ["checklist", "counsel", "tax advisor", "filing fee"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
