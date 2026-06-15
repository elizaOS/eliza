import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "expat-payroll-shadow-tax",
  title: "Assistant coordinates expat payroll shadow tax decisions",
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
      title: "LifeOps Expat Payroll Shadow Tax",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-expat-tax-inputs",
      text: "The Singapore assignment payroll review is due. Gather compensation memo, tax equalization policy, housing allowance, visa dates, payroll contact, and decisions that need approval.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["tax", "housing", "visa", "approval"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-payroll-advisor-note",
      text: "Draft questions for payroll and the tax advisor. Do not expose compensation details beyond the advisor group.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["payroll", "tax advisor", "compensation", "privacy"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
