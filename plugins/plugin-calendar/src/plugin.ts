/**
 * Plugin definition for `@elizaos/plugin-calendar`: registers `CalendarService`,
 * the deterministic conflict action, the non-destructive migration service,
 * the `app_calendar` schema, and the provider-authenticated calendar webhook.
 */
import type { Plugin } from "@elizaos/core";
import { calendarAction } from "./actions/calendar.js";
import { conflictDetectAction } from "./actions/conflict-detect.js";
import { calendarHttpRoutes } from "./routes/plugin-routes.js";
import { CalendarService } from "./service/CalendarService.js";
import { CalendarMigrationService } from "./service/migration.js";
import { calendarSchema } from "./service/schema.js";

/**
 * First-class calendar plugin. Owns the calendar domain that previously lived
 * inside `@elizaos/plugin-personal-assistant`: the calendar event/sync store, the
 * Google, Microsoft, Apple, and ICS calendar feeds; event CRUD for writable
 * providers; the CALENDAR action; the host route adapter and Google webhook;
 * the client API, and the owner-facing calendar views.
 *
 */
export const calendarPlugin: Plugin = {
  name: "calendar",
  description:
    "Multi-provider calendar feeds, scheduling, and event management for Eliza agents.",
  schema: calendarSchema,
  services: [CalendarMigrationService, CalendarService],
  actions: [calendarAction, conflictDetectAction],
  providers: [],
  routes: calendarHttpRoutes,
  views: [
    // The shipped view is GUI-only. `modalities` is a plain literal here
    // (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "calendar",
      label: "Calendar",
      description:
        "Unified Google, Microsoft, Apple, and ICS calendar with day/week/month tabs and inline conflict detection.",
      icon: "Calendar",
      path: "/calendar",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "CalendarView",
      tags: ["calendar", "schedule", "events"],
      relatedActions: ["CALENDAR", "CONFLICT_DETECT"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default calendarPlugin;
