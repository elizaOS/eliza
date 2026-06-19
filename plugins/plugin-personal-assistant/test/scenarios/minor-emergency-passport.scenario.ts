import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "minor-emergency-passport",
  title: "Assistant coordinates a minor's emergency passport appointment",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "travel", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Minor Emergency Passport",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-minor-passport-packet",
      text: "The child's passport expires before travel. Assemble DS-11 requirements, birth certificate, parent consent, photo appointment, travel proof, and agency appointment windows.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "travel"],
      responseIncludesAny: ["DS-11", "birth certificate", "consent", "appointment"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "coordinate-parent-consent",
      text: "Draft parent coordination messages and reminders, but don't include the child's full passport or birth certificate details in broad channels.",
      plannerIncludesAny: ["owner_send_message", "privacy", "SCHEDULED_TASKS"],
      responseIncludesAny: ["parent", "reminders", "passport", "privacy"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
