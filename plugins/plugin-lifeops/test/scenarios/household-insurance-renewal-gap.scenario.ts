import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "household-insurance-renewal-gap",
  title: "Assistant finds household insurance renewal gap",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "money", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Household Insurance Renewal Gap",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-renewal-gap",
      text: "Check whether any household insurance policy is about to lapse. Pull renewal invoices, broker contacts, coverage changes, payment status, and grace periods.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["lapse", "broker", "coverage", "grace"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-renewal-repair",
      text: "Draft broker questions and a payment approval note. Ask before paying, binding coverage, or sending policy details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["broker", "payment", "coverage", "policy"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
