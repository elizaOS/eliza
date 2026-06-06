import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "school-trip-permission-stack",
  title: "Assistant handles school trip permission stack",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "documents", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps School Trip Permission Stack",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-trip-permissions",
      text: "The school trip packet is due: permission slip, emergency contacts, payment amount, passport copy, allergy note, and chaperone logistics.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "deadline"],
      responseIncludesAny: ["permission", "payment", "passport", "chaperone"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "stage-trip-submission",
      text: "Draft the submission checklist and reminders. Ask me before sending the passport copy or paying the trip fee.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["checklist", "passport", "paying", "trip fee"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
