import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "school-accommodation-privacy",
  title: "Assistant coordinates school accommodation privately",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "privacy", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps School Accommodation Privacy",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-school-accommodation",
      text: "Coordinate the school accommodation request: forms, teacher meeting windows, counselor contact, privacy limits, and documents I need to review first.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["forms", "teacher", "counselor", "privacy"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-school-messages",
      text: "Draft messages to the counselor and teacher, but avoid medical specifics unless I explicitly approve each recipient.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["counselor", "teacher", "medical", "approve"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
