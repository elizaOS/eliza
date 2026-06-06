import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "travel-blackout-bulk-reschedule",
  title: "Travel disruption clears and reschedules partnership meetings",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Travel Blackout Bulk Reschedule",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bulk-reschedule-authorized",
      text: "I'm stuck traveling. Clear my partnership calls this week, push them to next month, and draft apologies to each person before anything sends.",
      plannerIncludesAll: ["calendar_action", "owner_send_message"],
      plannerIncludesAny: ["reschedule", "partnership", "draft", "approval"],
      responseIncludesAny: ["draft", "approval", "reschedule", "next month"],
      plannerExcludes: ["spawn_agent", "send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "protect-vips-from-bulk-change",
      text: "Keep anything with Sam or the board unless it conflicts with the flight.",
      plannerIncludesAll: ["calendar_action"],
      plannerIncludesAny: ["sam", "board", "flight", "conflict"],
      responseIncludesAny: ["exception", "conflict", "board", "Sam"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
