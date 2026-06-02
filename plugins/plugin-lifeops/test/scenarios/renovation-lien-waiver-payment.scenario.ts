import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "renovation-lien-waiver-payment",
  title: "Assistant holds renovation payment for lien waiver",
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
      title: "LifeOps Renovation Lien Waiver Payment",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-contractor-payment",
      text: "The renovation contractor wants the final payment. Pull invoice, lien waiver, punch list, inspection signoff, warranty docs, and payment deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "approval"],
      responseIncludesAny: ["invoice", "lien waiver", "punch list", "inspection"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-payment-hold",
      text: "Draft a contractor note and payment approval checklist. Ask before paying or accepting the lien waiver language.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["contractor", "checklist", "paying", "lien waiver"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
