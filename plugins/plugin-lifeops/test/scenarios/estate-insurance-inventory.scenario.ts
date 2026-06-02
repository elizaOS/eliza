import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "estate-insurance-inventory",
  title: "Assistant prepares estate insurance inventory",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "documents", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Estate Insurance Inventory",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-insurance-inventory",
      text: "Update the estate insurance inventory: art list, jewelry appraisal, electronics receipts, household staff access, and broker renewal deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "deadline"],
      responseIncludesAny: ["art", "appraisal", "receipts", "broker"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-broker-update",
      text: "Draft the broker update and missing-doc checklist. Ask before sending any itemized location list.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["broker", "missing-doc", "itemized", "location"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
