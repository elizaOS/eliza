import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "philanthropy-grant-diligence",
  title: "Assistant coordinates philanthropy grant diligence and approval",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "money", "approval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Philanthropy Grant Diligence",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-grant-diligence",
      text: "Prepare diligence for the emergency grant: nonprofit status, bank letter, board approval requirement, restricted-purpose language, matching deadline, and prior giving history.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["nonprofit", "bank letter", "board approval", "deadline"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-grant-approval",
      text: "Draft the approval note and the grant agreement checklist. Do not initiate payment or share banking data without approval.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["approval", "agreement", "payment", "banking"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
