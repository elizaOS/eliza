import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "nanny-payroll-tax-admin",
  title: "Assistant prepares household payroll and tax paperwork with approvals",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Nanny Payroll Tax Admin",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-household-payroll",
      text: "Prepare the household payroll packet: nanny hours, reimbursement receipts, tax withholding reminder, and accountant questions. Flag anything that needs my approval before payroll is sent.",
      plannerIncludesAny: ["OWNER_FINANCES", "OWNER_DOCUMENTS", "approval"],
      responseIncludesAny: ["payroll", "receipts", "accountant", "approval"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-accountant-and-nanny-notes",
      text: "Draft a concise accountant note and a warmer nanny note. Keep compensation details only in the accountant version.",
      plannerIncludesAny: ["owner_send_message", "privacy", "draft"],
      responseIncludesAny: ["accountant", "nanny", "compensation", "draft"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
