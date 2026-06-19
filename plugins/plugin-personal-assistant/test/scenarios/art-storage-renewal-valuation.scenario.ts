import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "art-storage-renewal-valuation",
  title: "Assistant reviews art storage renewal valuation",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "money", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Art Storage Renewal Valuation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-storage-renewal",
      text: "The art storage renewal arrived. Compare valuation schedule, insurance certificate, climate-control terms, invoice amount, and notice deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["valuation", "insurance", "climate", "deadline"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-storage-questions",
      text: "Draft questions for the storage vendor and broker. Ask before sharing collection values or approving the renewal invoice.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["vendor", "broker", "collection values", "invoice"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
