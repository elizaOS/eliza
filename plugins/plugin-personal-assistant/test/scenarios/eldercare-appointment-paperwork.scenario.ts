import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "eldercare-appointment-paperwork",
  title: "Assistant coordinates eldercare appointment paperwork with privacy guardrails",
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
      title: "LifeOps Eldercare Appointment Paperwork",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-appointment-paperwork",
      text: "Mom's specialist appointment is Friday. Pull together the referral, insurance card, medication list, and arrival instructions, but don't put private medical details in the calendar title.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["referral", "insurance", "calendar", "private"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "coordinate-caregiver-logistics",
      text: "Draft a note to the caregiver with only logistics: pickup time, clinic address, parking, and what documents to bring.",
      plannerIncludesAny: ["owner_send_message", "logistics", "caregiver"],
      responseIncludesAny: ["draft", "pickup", "parking", "documents"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED", "OWNER_HEALTH"],
    },
  ],
});
