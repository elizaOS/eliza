import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "memorial-logistics-family-brief",
  title: "Assistant coordinates memorial logistics across family, travel, and vendors",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "family", "vendor"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Memorial Logistics Family Brief",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-memorial-plan",
      text: "Coordinate the memorial plan: family travel, venue hold, florist, obituary draft, and who needs a personal call rather than a group message.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "relationship"],
      responseIncludesAny: ["travel", "venue", "florist", "call"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "stage-sensitive-family-comms",
      text: "Draft the group update, but keep the personal call list separate and do not include private family conflict in the group note.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["group", "private", "family", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
