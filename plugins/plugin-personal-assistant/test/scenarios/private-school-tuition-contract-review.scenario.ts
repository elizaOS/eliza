import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "private-school-tuition-contract-review",
  title: "Assistant reviews private school tuition contract",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Private School Tuition Contract Review",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-tuition-contract",
      text: "The school sent next year's tuition contract. Extract payment schedule, withdrawal penalty, scholarship status, bus options, and signature deadline.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "SCHEDULED_TASKS"],
      responseIncludesAny: ["payment", "withdrawal", "scholarship", "deadline"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-school-questions",
      text: "Draft school questions and a signing checklist. Ask before signing, paying the deposit, or disclosing scholarship details.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["questions", "checklist", "deposit", "scholarship"],
      plannerExcludes: ["PAYMENT_EXECUTED", "MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
