import type { Plugin } from "@elizaos/core";

/**
 * First-class calendar plugin. Owns the calendar domain that previously lived
 * inside `@elizaos/plugin-lifeops`: the calendar event/sync store, the
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
  services: [],
  actions: [],
  providers: [],
};

export default calendarPlugin;
