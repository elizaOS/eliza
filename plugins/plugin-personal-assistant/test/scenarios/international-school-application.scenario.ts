import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "international-school-application",
  title: "Assistant coordinates an international school application packet",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "documents", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps International School Application",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-application-packet",
      text: "The Zurich school application is due Friday. Assemble transcripts, vaccination form routing, teacher recommendation asks, passport copies, and interview slots across our calendars.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "owner_send_message"],
      responseIncludesAny: ["transcripts", "teacher", "passport", "interview"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "coordinate-parent-signoffs",
      text: "Make a parent signoff checklist and draft polite nudges for the registrar and two teachers. Keep the child's sensitive details out of broad messages.",
      plannerIncludesAny: ["approval", "privacy", "SCHEDULED_TASKS"],
      responseIncludesAny: ["signoff", "registrar", "teachers", "privacy"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
