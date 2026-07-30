/**
 * Personal-assistant authorization adapter for the calendar-owned
 * CALENDAR_SOURCES action.
 *
 * PA does not compose its own CALENDAR_SOURCES instance — the calendar
 * plugin's registration stays canonical (see
 * `ensureLifeOpsCalendarPluginRegistered` in plugin.ts) — so PA substitutes
 * its `hasLifeOpsAccess` gate through the calendar plugin's runtime-keyed
 * host-adapter registry instead. Calendar owns source discovery, feed
 * selection, ICS sync, and the owner handoff semantics.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type CalendarSourcesActionDeps,
  registerCalendarSourcesHostAdapter,
} from "@elizaos/plugin-calendar/actions/calendar-sources";
import { hasLifeOpsAccess } from "../lifeops/access.js";

const personalAssistantCalendarSourcesDeps: CalendarSourcesActionDeps = {
  authorize: hasLifeOpsAccess,
};

export function registerPersonalAssistantCalendarSourcesHost(
  runtime: IAgentRuntime,
): void {
  registerCalendarSourcesHostAdapter(
    runtime,
    personalAssistantCalendarSourcesDeps,
  );
}
