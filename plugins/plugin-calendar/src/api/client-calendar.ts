/**
 * Calendar client methods — side-effect augmentation of the `@elizaos/ui`
 * `ElizaClient` prototype. Importing this module attaches the calendar feed /
 * event CRUD methods onto every `client` instance, so any surface that depends
 * on `@elizaos/ui` (the LifeOps dashboard, the task-coordinator
 * CalendarView, …) can call them after a single side-effect import.
 *
 * The HTTP routes are still mounted under `/api/lifeops/calendar/*`; the paths
 * are stable contract surface and intentionally unchanged by the extraction.
 */

import type {
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEventMutationResult,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
  SetLifeOpsCalendarIncludedRequest,
} from "@elizaos/shared";
// Load the `@elizaos/ui` barrel so the `declare module "@elizaos/ui"`
// augmentation below resolves; the calendar methods are exposed on the
// public `ElizaClient` surface that consumers import from `@elizaos/ui`.
import type {} from "@elizaos/ui";
import { ElizaClient } from "@elizaos/ui/api";
import type {
  MeetingAutoJoinPolicy,
  MeetingAutoJoinSettings,
} from "../meetings/auto-join-settings.js";

export interface CalendarClientMethods {
  getLifeOpsCalendarFeed(
    options?: GetLifeOpsCalendarFeedRequest,
  ): Promise<LifeOpsCalendarFeed>;
  getLifeOpsCalendars(
    options?: ListLifeOpsCalendarsRequest,
  ): Promise<{ calendars: LifeOpsCalendarSummary[] }>;
  setLifeOpsCalendarIncluded(
    data: SetLifeOpsCalendarIncludedRequest,
  ): Promise<{ calendar: LifeOpsCalendarSummary }>;
  getLifeOpsNextCalendarEventContext(
    options?: GetLifeOpsCalendarFeedRequest,
  ): Promise<LifeOpsNextCalendarEventContext>;
  createLifeOpsCalendarEvent(
    data: CreateLifeOpsCalendarEventRequest,
  ): Promise<{ event: LifeOpsCalendarFeed["events"][number] }>;
  updateLifeOpsCalendarEvent(
    eventId: string,
    patch: LifeOpsCalendarEventUpdate,
  ): Promise<LifeOpsCalendarEventMutationResult>;
  deleteLifeOpsCalendarEvent(
    eventId: string,
    options?: Partial<
      Pick<
        LifeOpsCalendarEventUpdate,
        "calendarId" | "grantId" | "side" | "recurrenceScope"
      >
    >,
  ): Promise<{ deleted: true }>;
  getMeetingAutoJoinSettings(): Promise<MeetingAutoJoinSettings>;
  setMeetingAutoJoinPolicy(
    policy: MeetingAutoJoinPolicy,
  ): Promise<MeetingAutoJoinSettings>;
}

// The `/api/meetings` client (requestMeetingBot / listMeetings / getMeeting /
// stopMeeting) is canonical in `@elizaos/ui` (packages/ui/src/api/client-meetings.ts)
// and already installed on this same prototype via the `@elizaos/ui/api`
// side-effect import. Do NOT re-declare meeting join/list methods here — call
// the ui client's `requestMeetingBot` / `listMeetings` directly.

declare module "@elizaos/ui" {
  interface ElizaClient extends CalendarClientMethods {}
}

const calendarClientPrototype = ElizaClient.prototype as ElizaClient &
  CalendarClientMethods;

calendarClientPrototype.getLifeOpsCalendarFeed = async function (
  this: ElizaClient,
  options: GetLifeOpsCalendarFeedRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.grantId) params.set("grantId", options.grantId);
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.includeHiddenCalendars !== undefined) {
    params.set(
      "includeHiddenCalendars",
      String(options.includeHiddenCalendars),
    );
  }
  if (options.timeMin) params.set("timeMin", options.timeMin);
  if (options.timeMax) params.set("timeMax", options.timeMax);
  if (options.timeZone) params.set("timeZone", options.timeZone);
  if (options.forceSync !== undefined) {
    params.set("forceSync", String(options.forceSync));
  }
  const query = params.toString();
  return this.fetch<LifeOpsCalendarFeed>(
    `/api/lifeops/calendar/feed${query ? `?${query}` : ""}`,
  );
};

calendarClientPrototype.getLifeOpsCalendars = async function (
  this: ElizaClient,
  options: ListLifeOpsCalendarsRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.grantId) params.set("grantId", options.grantId);
  const query = params.toString();
  return this.fetch<{ calendars: LifeOpsCalendarSummary[] }>(
    `/api/lifeops/calendar/calendars${query ? `?${query}` : ""}`,
  );
};

calendarClientPrototype.setLifeOpsCalendarIncluded = async function (
  this: ElizaClient,
  data: SetLifeOpsCalendarIncludedRequest,
) {
  return this.fetch<{ calendar: LifeOpsCalendarSummary }>(
    `/api/lifeops/calendar/calendars/${encodeURIComponent(data.calendarId)}/include`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.getLifeOpsNextCalendarEventContext = async function (
  this: ElizaClient,
  options: GetLifeOpsCalendarFeedRequest = {},
) {
  const params = new URLSearchParams();
  if (options.mode) params.set("mode", options.mode);
  if (options.side) params.set("side", options.side);
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.timeMin) params.set("timeMin", options.timeMin);
  if (options.timeMax) params.set("timeMax", options.timeMax);
  if (options.timeZone) params.set("timeZone", options.timeZone);
  const query = params.toString();
  return this.fetch<LifeOpsNextCalendarEventContext>(
    `/api/lifeops/calendar/next-context${query ? `?${query}` : ""}`,
  );
};

calendarClientPrototype.createLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  data: CreateLifeOpsCalendarEventRequest,
) {
  return this.fetch<{ event: LifeOpsCalendarFeed["events"][number] }>(
    "/api/lifeops/calendar/events",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
};

calendarClientPrototype.updateLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId: string,
  patch: LifeOpsCalendarEventUpdate,
) {
  return this.fetch<LifeOpsCalendarEventMutationResult>(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
};

calendarClientPrototype.deleteLifeOpsCalendarEvent = async function (
  this: ElizaClient,
  eventId: string,
  options: Partial<
    Pick<
      LifeOpsCalendarEventUpdate,
      "calendarId" | "grantId" | "side" | "recurrenceScope"
    >
  > = {},
) {
  const params = new URLSearchParams();
  if (options.calendarId) params.set("calendarId", options.calendarId);
  if (options.grantId) params.set("grantId", options.grantId);
  if (options.side) params.set("side", options.side);
  if (options.recurrenceScope) {
    params.set("recurrenceScope", options.recurrenceScope);
  }
  const query = params.toString();
  return this.fetch<{ deleted: true }>(
    `/api/lifeops/calendar/events/${encodeURIComponent(eventId)}${query ? `?${query}` : ""}`,
    {
      method: "DELETE",
    },
  );
};

calendarClientPrototype.getMeetingAutoJoinSettings = async function (
  this: ElizaClient,
) {
  return this.fetch<MeetingAutoJoinSettings>(
    "/api/lifeops/calendar/meeting-auto-join",
  );
};

calendarClientPrototype.setMeetingAutoJoinPolicy = async function (
  this: ElizaClient,
  policy: MeetingAutoJoinPolicy,
) {
  return this.fetch<MeetingAutoJoinSettings>(
    "/api/lifeops/calendar/meeting-auto-join",
    {
      method: "PUT",
      body: JSON.stringify({ policy }),
    },
  );
};
