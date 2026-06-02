import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "daily-brief-cross-channel",
  title: "Daily brief crosses calendar, inbox, drafts, tasks, and money",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "inbox"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Daily Brief Cross Channel",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "daily-brief",
      text: "Give me the brief: calendar, unread urgent messages, waiting drafts, bills due, and what you need from me.",
      plannerIncludesAll: ["BRIEF"],
      plannerIncludesAny: ["calendar", "inbox", "draft", "money", "life"],
      responseIncludesAny: ["calendar", "urgent", "draft", "bill", "need"],
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "compress-brief",
      text: "Now compress that into a five-line executive summary with the one decision I should make first.",
      plannerIncludesAny: ["BRIEF", "PRIORITIZE", "decision", "summary"],
      responseIncludesAny: ["decision", "first", "summary"],
      plannerExcludes: ["calendar_action", "gmail_action"],
    },
  ],
});
