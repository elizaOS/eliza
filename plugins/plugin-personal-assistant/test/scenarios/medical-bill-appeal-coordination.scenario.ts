import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "medical-bill-appeal-coordination",
  title: "Assistant coordinates a medical bill appeal without handling health details",
  domain: "executive.money",
  tags: ["lifeops", "executive-assistant", "money", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Medical Bill Appeal Coordination",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-billing-context",
      text: "This medical bill looks wrong. Collect the invoice, insurance EOB, payment records, and appeal deadline, but don't summarize diagnosis details.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "privacy"],
      responseIncludesAny: ["invoice", "insurance", "deadline", "privacy"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-billing-appeal",
      text: "Draft the billing appeal and a reminder to call if they have not responded in ten business days.",
      plannerIncludesAny: ["owner_send_message", "SCHEDULED_TASKS", "appeal"],
      responseIncludesAny: ["draft", "reminder", "business days"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
