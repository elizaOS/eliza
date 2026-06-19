import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "household-staff-payroll-correction",
  title: "Assistant corrects household staff payroll issue",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "money", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Household Staff Payroll Correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-payroll-error",
      text: "The house manager says payroll shorted a caregiver. Pull timesheets, payroll provider ticket, wage rate, tax treatment, and correction deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "priority"],
      responseIncludesAny: ["timesheets", "payroll", "wage", "deadline"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-correction",
      text: "Draft the payroll correction request and caregiver update. Ask before sending compensation details or approving any payment.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["correction", "caregiver", "compensation", "payment"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
