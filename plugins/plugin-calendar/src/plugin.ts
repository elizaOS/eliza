/**
 * Plugin definition for `@elizaos/plugin-calendar`: registers `CalendarService`,
 * the non-destructive `CalendarMigrationService`, the `app_calendar` schema, and
 * the `/api/calendar/*` HTTP routes. Requires `@elizaos/plugin-sql` loaded first.
 */
import type { Plugin } from "@elizaos/core";
import { calendarHttpRoutes } from "./routes/plugin-routes.js";
import { CalendarService } from "./service/CalendarService.js";
import { CalendarMigrationService } from "./service/migration.js";
import { calendarSchema } from "./service/schema.js";

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
  schema: calendarSchema,
  services: [CalendarService, CalendarMigrationService],
  // Host-adapted action factories live in ./actions. The standalone plugin
  // should not register scaffold action handlers; PA registers the owner-gated
  // CALENDAR / CONFLICT_DETECT actions after injecting its LifeOps adapters.
  actions: [],
  providers: [],
  routes: calendarHttpRoutes,
  views: [
    // ONE declaration → GUI + XR + TUI, all drawn from the single CalendarView
    // spatial source. `modalities` is a plain literal here (plugin.ts is not in
    // the view bundle), so no brand-new `@elizaos/core` runtime export reaches
    // the bundle build.
    {
      id: "calendar",
      label: "Calendar",
      description:
        "Unified Google + Apple calendar with day/week/month tabs and inline conflict detection.",
      icon: "Calendar",
      path: "/calendar",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "CalendarView",
      tags: ["calendar", "schedule", "events"],
      relatedActions: ["CALENDAR", "CONFLICT_DETECT"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default calendarPlugin;
