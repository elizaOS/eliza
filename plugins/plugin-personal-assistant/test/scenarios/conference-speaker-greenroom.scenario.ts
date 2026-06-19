import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "conference-speaker-greenroom",
  title: "Assistant coordinates a conference speaker greenroom run of show",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "schedule", "travel", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Conference Speaker Greenroom",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "reconcile-speaker-run-of-show",
      text: "For the keynote, reconcile greenroom arrival, AV test, slide lock, press embargo, security escort, hotel checkout, and flight departure.",
      plannerIncludesAny: ["calendar_action", "travel", "privacy"],
      responseIncludesAny: ["greenroom", "AV", "press", "flight"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-stakeholder-updates",
      text: "Draft concise updates for PR, event ops, security, and the chief of staff. Keep embargo details limited to PR and me.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["PR", "event ops", "security", "embargo"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
