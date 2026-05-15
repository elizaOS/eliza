import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "calendar-llm-eval-mutations",
  title: "Calendar LLM evals cover check, add, move, delete, and search",
  domain: "calendar",
  tags: ["lifeops", "calendar", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Calendar LLM Eval Mutations",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "calendar-check",
      text: "What's on my calendar today?",
      plannerIncludesAll: ["calendar_action"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "calendar-add",
      text: "Add a calendar event: planning sync with Alex tomorrow at 3pm.",
      plannerIncludesAll: ["calendar_action", "create_event", "alex"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "calendar-move",
      text: "Move my dentist appointment to Friday at 10am.",
      plannerIncludesAll: ["calendar_action", "update_event", "dentist"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "calendar-delete",
      text: "Delete the duplicate team meeting tomorrow.",
      plannerIncludesAll: ["calendar_action", "delete_event", "team"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "calendar-multi-search",
      text: "Search all calendar events for investor dinner, return flight, and dentist.",
      plannerIncludesAll: ["calendar_action"],
      plannerIncludesAny: [
        "search_events",
        "investor",
        "return flight",
        "dentist",
      ],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
  ],
});
