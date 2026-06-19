import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "missed-call-repair-reschedule",
  title: "Missed call repair drafts apology and proposes new times",
  domain: "executive.followup",
  tags: ["lifeops", "executive-assistant", "followup", "calendar", "email"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Missed Call Repair",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "repair-missed-call",
      text: "I missed the Frontier Tower call. Draft an apology, find two times tomorrow, and ask before sending.",
      plannerIncludesAll: ["owner_send_message", "calendar_action"],
      plannerIncludesAny: ["frontier", "apology", "tomorrow", "approval"],
      responseIncludesAny: ["draft", "approval", "times", "apology"],
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "tighten-tone",
      text: "Make it shorter and don't over-explain why I missed it.",
      plannerIncludesAll: ["owner_send_message"],
      plannerIncludesAny: ["shorter", "draft", "tone"],
      responseIncludesAny: ["shorter", "draft", "approval"],
      plannerExcludes: ["calendar_action"],
    },
  ],
});
