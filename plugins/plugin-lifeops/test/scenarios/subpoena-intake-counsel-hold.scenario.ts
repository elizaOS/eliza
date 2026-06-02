import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "subpoena-intake-counsel-hold",
  title: "Assistant holds subpoena intake for counsel",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "privacy", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Subpoena Intake Counsel Hold",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-subpoena",
      text: "A subpoena was served at the office. Preserve the document, service details, response deadline, custodians, and counsel escalation path without replying.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["service", "deadline", "custodians", "counsel"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-counsel-handoff",
      text: "Draft a counsel handoff and custodian preservation checklist. Ask before contacting the requester or telling staff what to preserve.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["handoff", "preservation", "requester", "staff"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
