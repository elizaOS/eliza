import type { Plugin } from "@elizaos/core";
import { calendarAction } from "./actions/calendar.js";
import { conflictDetectAction } from "./actions/conflict-detect.js";
import { CalendarService } from "./service/CalendarService.js";

/**
 * First-class calendar plugin. Owns the calendar domain that previously lived
 * inside `@elizaos/plugin-personal-assistant`: the calendar event/sync store, the
 * Google + Apple calendar feed, event CRUD, the CALENDAR action, HTTP routes,
 * the client API, and the owner-facing calendar views.
 *
 * Actions / services / providers / routes are registered here as the
 * extraction proceeds.
 */
export const calendarPlugin: Plugin = {
  name: "calendar",
  description:
    "Calendar feed and event management (Google + Apple) for Eliza agents.",
  services: [CalendarService],
  actions: [calendarAction, conflictDetectAction],
  providers: [],
  views: [
    {
      id: "calendar",
      label: "Calendar",
      description:
        "Unified Google + Apple calendar with day/week/month tabs and inline conflict detection.",
      icon: "Calendar",
      path: "/calendar",
      bundlePath: "dist/views/bundle.js",
      componentExport: "CalendarView",
      tags: ["calendar", "schedule", "events"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default calendarPlugin;
