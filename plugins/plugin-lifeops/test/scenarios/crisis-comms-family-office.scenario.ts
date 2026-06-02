import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "crisis-comms-family-office",
  title: "Assistant creates a crisis communication plan with channel-specific approvals",
  domain: "executive.escalation",
  tags: ["lifeops", "executive-assistant", "messaging", "privacy"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Crisis Comms Family Office",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-crisis-comms-plan",
      text: "A private family matter may become public tomorrow. Build a communications plan for family, board, assistant, and attorney channels. Keep sensitive facts out of drafts until I approve.",
      plannerIncludesAny: ["PERSONAL_ASSISTANT", "privacy", "approval"],
      responseIncludesAny: ["family", "board", "attorney", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-channel-drafts",
      text: "Stage the shortest version for text, the formal version for email, and a holding statement for the board packet.",
      plannerIncludesAny: ["owner_send_message", "OWNER_DOCUMENTS", "draft"],
      responseIncludesAny: ["text", "email", "board", "draft"],
      plannerExcludes: ["send_to_agent"],
    },
  ],
});
