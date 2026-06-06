import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "kid-camp-medical-form-deadline",
  title: "Assistant coordinates camp medical form deadline",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "documents", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Kid Camp Medical Form Deadline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-camp-forms",
      text: "Camp says medical forms are missing. Find the due date, required forms, pediatrician contact, immunization record, medication notes, and upload method.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["due date", "pediatrician", "immunization", "upload"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-family-requests",
      text: "Draft the pediatrician request and a parent checklist. Ask before sending medical details or uploading forms.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["pediatrician", "checklist", "medical", "uploading"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
