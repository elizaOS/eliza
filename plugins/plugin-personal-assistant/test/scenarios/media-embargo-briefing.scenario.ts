import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "media-embargo-briefing",
  title: "Assistant coordinates media embargo briefing",
  domain: "executive.messaging",
  tags: ["lifeops", "executive-assistant", "messaging", "privacy", "briefing"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Media Embargo Briefing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-embargo",
      text: "A reporter wants an embargoed briefing. Gather embargo time, approved facts, off-limits topics, comms owner, quote approval path, and calendar options.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "privacy"],
      responseIncludesAny: ["embargo", "approved facts", "off-limits", "quote"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-reporter-note",
      text: "Draft the reporter scheduling note and internal approval brief. Ask before sharing embargoed facts or confirming a quote.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["reporter", "approval", "embargoed", "quote"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
