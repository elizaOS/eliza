/**
 * UI-only barrel for `@elizaos/plugin-calendar`.
 *
 * Exposes the owner-facing calendar components + hook without pulling in the
 * server-side action / service graph that the package root (`index.ts`)
 * re-exports. Host shells (e.g. `@elizaos/plugin-lifeops`) import from here so
 * their renderer view bundles never reach the agent/connector dependency tree.
 */

export {
  CalendarSection,
  type CalendarSectionProps,
} from "./components/CalendarSection.js";
export {
  EventEditorDrawer,
  type EventEditorDefaults,
  type EventEditorDrawerProps,
  type EventEditorMode,
} from "./components/EventEditorDrawer.js";
export {
  type CalendarViewMode,
  useCalendarWeek,
  type UseCalendarWeekOptions,
  type UseCalendarWeekResult,
} from "./hooks/useCalendarWeek.js";
