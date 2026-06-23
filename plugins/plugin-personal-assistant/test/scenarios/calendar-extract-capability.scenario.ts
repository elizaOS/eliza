import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the `calendar_extract` LifeOps capability.
 *
 * The calendar planner (`extractCalendarPlanWithLlm` in `@elizaos/plugin-calendar`)
 * turns a natural-language request into a structured plan: a `subaction`
 * (feed / search_events / create_event / update_event / delete_event /
 * trip_window) plus an extracted time window and search queries. Its
 * instruction body is the GEPA-optimizable `calendar_extract` prompt routed
 * through `OptimizedPromptService`.
 *
 * This scenario asserts the extraction routes each request to the calendar
 * action with the correct subaction and entities, across the read, create,
 * reschedule, and trip-window slices. It mirrors `calendar-llm-eval-mutations`
 * but is scoped to the extraction capability and adds a final selected-action
 * check so a regression in the wired prompt surfaces as a failing scenario.
 */
export default scenario({
  lane: "live-only",
  id: "calendar-extract-capability",
  title: "Calendar extract capability routes requests to the right subaction",
  domain: "calendar",
  tags: ["lifeops", "calendar", "calendar_extract", "llm-eval"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Calendar Extract Capability",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "extract-feed-window",
      text: "What do I have on my calendar tomorrow?",
      plannerIncludesAll: ["calendar_action"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "extract-create-event",
      text: "Put a dinner with Priya on my calendar Friday at 7pm.",
      plannerIncludesAll: ["calendar_action", "create_event", "priya"],
      plannerExcludes: ["search_events", "gmail_action"],
    },
    {
      kind: "message",
      name: "extract-reschedule",
      text: "Move my standup to Wednesday at 9am.",
      plannerIncludesAll: ["calendar_action", "update_event", "standup"],
      plannerExcludes: ["create_event", "delete_event", "gmail_action"],
    },
    {
      kind: "message",
      name: "extract-trip-window",
      text: "What's happening while I'm in Tokyo next week?",
      plannerIncludesAll: ["calendar_action", "trip_window", "tokyo"],
      plannerExcludes: ["create_event", "gmail_action"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "calendar action selected for every extract turn",
      actionName: "CALENDAR",
    },
  ],
});
