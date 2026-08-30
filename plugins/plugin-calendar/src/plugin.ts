/**
 * Plugin definition for `@elizaos/plugin-calendar`: registers `CalendarService`,
 * the deterministic conflict action, the non-destructive migration service,
 * the `app_calendar` schema, the Microsoft connector-account OAuth provider,
 * and the provider-authenticated calendar webhook.
 */
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type Plugin,
} from "@elizaos/core";
import { calendarAction } from "./actions/calendar.js";
import { calendarSourcesAction } from "./actions/calendar-sources.js";
import { conflictDetectAction } from "./actions/conflict-detect.js";
import { createMicrosoftConnectorAccountProvider } from "./microsoft/connector-account-provider.js";
import { calendarSourcesProvider } from "./providers/calendar-sources.js";
import { calendarHttpRoutes } from "./routes/plugin-routes.js";
import { CalendarService } from "./service/CalendarService.js";
import { CalendarMigrationService } from "./service/migration.js";
import { calendarSchema } from "./service/schema.js";
import { CALENDAR_VIEW_CAPABILITIES } from "./view-capabilities.js";
import { serverInteract } from "./view-interact.js";

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
  dependencies: ["@elizaos/plugin-scheduling"],
  schema: calendarSchema,
  services: [CalendarMigrationService, CalendarService],
  actions: [calendarAction, calendarSourcesAction, conflictDetectAction],
  providers: [calendarSourcesProvider],
  routes: calendarHttpRoutes,
  init: async (
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> => {
    const manager = getConnectorAccountManager(runtime);
    manager.registerProvider(createMicrosoftConnectorAccountProvider(runtime));
    logger.info(
      { src: "plugin:calendar:microsoft-oauth" },
      "Registered Microsoft connector account provider",
    );
  },
  views: [
    // The shipped view is GUI-only. `modalities` is a plain literal here
    // (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core`
    // runtime export reaches the bundle build.
    {
      id: "calendar",
      label: "Calendar",
      // Calendar data is owner-private (the LifeOps CALENDAR umbrella stamps
      // the owner-exclusive disclosure gate on the action surface); the view's
      // server capabilities follow the Notes precedent and stay owner-gated.
      roleGate: { minRole: "OWNER" },
      description:
        "Chat-first calendar over unified Google, Microsoft, Apple, and ICS events.",
      icon: "CalendarDays",
      path: "/calendar",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: {
        header: "fullscreen",
        capabilities: ["agent-surface"],
      },
      // Server-executed capabilities (no mounted renderer required): the views
      // route prefers `serverInteract` for these declared non-standard ids, so
      // "create a new event for today" resolves to a real CalendarService write
      // with an effect receipt instead of a dead capability surface.
      capabilities: CALENDAR_VIEW_CAPABILITIES,
      serverInteract,
      componentExport: "CalendarView",
      tags: ["calendar", "schedule", "events"],
      responseContext: { primaryContext: "calendar" },
      relatedActions: ["CALENDAR", "CALENDAR_SOURCES", "CONFLICT_DETECT"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default calendarPlugin;
