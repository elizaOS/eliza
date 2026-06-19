import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "board-offsite-accessibility-logistics",
  title: "Assistant coordinates board offsite logistics with accessibility constraints",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "schedule", "privacy", "travel"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Board Offsite Accessibility Logistics",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "resolve-offsite-constraints",
      text: "Plan the board offsite with flight arrivals, dietary constraints, private accessibility needs, AV, security arrival windows, and a dinner hold. Keep personal constraints confidential.",
      plannerIncludesAny: ["calendar_action", "travel", "privacy"],
      responseIncludesAny: ["flights", "dietary", "accessibility", "security"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "send-role-specific-briefs",
      text: "Draft role-specific briefs for venue, security, board members, and the CEO. Each group gets only the details they need.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["venue", "security", "board", "CEO"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
