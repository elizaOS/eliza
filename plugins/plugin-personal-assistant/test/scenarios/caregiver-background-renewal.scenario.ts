import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "caregiver-background-renewal",
  title: "Assistant coordinates caregiver background renewal",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "household", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Caregiver Background Renewal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-background-renewal",
      text: "A caregiver background check renewal is due. Find consent forms, vendor portal, expiration date, household schedule constraints, and privacy notices.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "SCHEDULED_TASKS", "privacy"],
      responseIncludesAny: ["consent", "portal", "expiration", "privacy"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-renewal-outreach",
      text: "Draft the caregiver note and vendor checklist. Ask before sending personal data or starting the background check.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["caregiver", "checklist", "personal data", "background"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
