// Defines the calendar extract capability LifeOps scenario-runner spec.
import { scenario } from "@elizaos/scenario-runner/schema";

/**
 * Behavior scenario for the `calendar_extract` LifeOps capability.
 *
 * The calendar planner (`extractCalendarPlanWithLlm` in
 * `@elizaos/plugin-calendar`, model calls tagged `purpose: "calendar_extract"`)
 * turns a natural-language request into a structured plan. Its instruction
 * body is the GEPA-optimizable `calendar_extract` prompt routed through
 * `OptimizedPromptService`.
 *
 * Routing reality (verified against the promoted-action registry):
 * `@elizaos/plugin-personal-assistant` registers the CALENDAR umbrella via
 * `promoteSubactionsToActions(calendarAction)`, so the planner sees the
 * umbrella `CALENDAR` plus per-subaction virtuals (`CALENDAR_FEED`,
 * `CALENDAR_CREATE_EVENT`, ...). Each virtual injects the discriminator
 * (`"action":"create_event"` etc.) into the dispatched parameters, so the
 * planner-trace assertions below match either routing shape.
 *
 * Capability prompt path: the seven calendar-target subactions — feed,
 * next_event, search_events, create_event, update_event, delete_event,
 * trip_window — all delegate to the `@elizaos/plugin-calendar` handler, which
 * calls `extractCalendarPlanWithLlm` unconditionally, so any of those routes
 * exercises the `calendar_extract` prompt. The sibling subactions
 * bulk_reschedule / check_availability / propose_times / update_preferences
 * route elsewhere and NEVER run the extract prompt; the final selected-action
 * check therefore accepts only the extract-capable names.
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
      // Any calendar read (feed / next_event / search_events) reaches the
      // extract prompt; the bare umbrella (extraction resolves the subaction
      // itself) also qualifies. `\b` does not match across the underscore in
      // promoted names, so /\bCALENDAR\b/ alone would only match the umbrella.
      plannerIncludesAll: [/\bCALENDAR(_(FEED|NEXT_EVENT|SEARCH_EVENTS))?\b/],
      plannerExcludes: [
        /\bCALENDAR_(CREATE_EVENT|UPDATE_EVENT|DELETE_EVENT|BULK_RESCHEDULE|CHECK_AVAILABILITY|PROPOSE_TIMES|UPDATE_PREFERENCES)\b|"action":"(create_event|update_event|delete_event)"/,
        /\bMESSAGE(_[A-Z_]+)?\b/,
      ],
    },
    {
      kind: "message",
      name: "extract-create-event",
      text: "Put a dinner with Priya on my calendar Friday at 7pm.",
      plannerIncludesAll: [
        /\bCALENDAR_CREATE_EVENT\b|"action":"create_event"/,
        "priya",
      ],
      plannerExcludes: [
        /\bCALENDAR_(SEARCH_EVENTS|DELETE_EVENT)\b|"action":"(search_events|delete_event)"/,
        /\bMESSAGE(_[A-Z_]+)?\b/,
      ],
    },
    {
      kind: "message",
      name: "extract-reschedule",
      text: "Move my standup to Wednesday at 9am.",
      plannerIncludesAll: [
        /\bCALENDAR_UPDATE_EVENT\b|"action":"update_event"/,
        "standup",
      ],
      plannerExcludes: [
        /\bCALENDAR_(CREATE_EVENT|DELETE_EVENT)\b|"action":"(create_event|delete_event)"/,
        /\bMESSAGE(_[A-Z_]+)?\b/,
      ],
    },
    {
      kind: "message",
      name: "extract-trip-window",
      text: "What's happening while I'm in Tokyo next week?",
      plannerIncludesAll: [
        /\bCALENDAR_TRIP_WINDOW\b|"action":"trip_window"/,
        "tokyo",
      ],
      plannerExcludes: [
        /\bCALENDAR_(CREATE_EVENT|DELETE_EVENT)\b|"action":"(create_event|delete_event)"/,
        /\bMESSAGE(_[A-Z_]+)?\b/,
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      name: "calendar extract-capable action selected for every turn",
      // Only names whose dispatch reaches extractCalendarPlanWithLlm — the
      // four non-extract siblings (bulk_reschedule / check_availability /
      // propose_times / update_preferences) are intentionally absent.
      actionName: [
        "CALENDAR",
        "CALENDAR_FEED",
        "CALENDAR_NEXT_EVENT",
        "CALENDAR_SEARCH_EVENTS",
        "CALENDAR_CREATE_EVENT",
        "CALENDAR_UPDATE_EVENT",
        "CALENDAR_DELETE_EVENT",
        "CALENDAR_TRIP_WINDOW",
      ],
    },
    {
      type: "modelCallOccurred",
      name: "calendar_extract optimized-prompt model call fired",
      purpose: "calendar_extract",
      minCount: 1,
    },
  ],
});
