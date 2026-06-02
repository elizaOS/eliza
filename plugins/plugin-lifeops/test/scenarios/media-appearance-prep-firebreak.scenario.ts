import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "media-appearance-prep-firebreak",
  title: "Assistant prepares a media appearance with firebreaks",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "privacy", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Media Appearance Prep Firebreak",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-media-prep",
      text: "Prepare for the CNBC segment: approved talking points, topics to avoid, latest metrics, travel buffer, and PR lead approval status.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["talking points", "avoid", "metrics", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "draft-media-brief",
      text: "Draft a one-page brief and a separate firebreak note for sensitive questions. Do not send to producers without PR signoff.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["brief", "firebreak", "sensitive", "PR signoff"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
