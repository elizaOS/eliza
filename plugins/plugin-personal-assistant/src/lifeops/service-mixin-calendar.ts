/**
 * Calendar mixin — thin delegation shim.
 *
 * The calendar domain (feed sync, event CRUD, aggregation, next-event context,
 * reminder-plan scheduling for events) was extracted into the first-class
 * `@elizaos/plugin-calendar` package as `CalendarService`, and the LifeOps-side
 * surface lives in the `CalendarDomain` sub-service. This mixin keeps the
 * `LifeOpsService.<calendar>` method surface that LifeOps actions, routes,
 * providers, briefs, travel, and activity tracking already call, delegating
 * each call to the `CalendarDomain`.
 *
 * LifeOps injects a `CalendarHostGate` into the service at init (see
 * `calendar-gate.ts`) so calendar events keep firing reminders and writing
 * audit rows through the LifeOps repository.
 */

import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsCalendarSummary,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
  SetLifeOpsCalendarIncludedRequest,
  SetLifeOpsCalendarIncludedResponse,
} from "@elizaos/shared";

export interface LifeOpsCalendarService {
  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]>;
  setCalendarIncluded(
    requestUrl: URL,
    request: SetLifeOpsCalendarIncludedRequest,
  ): Promise<SetLifeOpsCalendarIncludedResponse>;
  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;
  createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarEvent>;
  createCalendarEventMutation(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<CreateLifeOpsCalendarEventResponse>;
  getAppleCalendarCreateAccess(): Promise<{
    provider: "apple_calendar";
    grantId: "apple-calendar";
    accessLevel: "full_access" | "write_only";
    readBackAvailable: boolean;
  }>;
  updateCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<LifeOpsCalendarEvent>;
  deleteCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion?: string;
      expectedOccurrenceProviderVersion?: string;
      idempotencyKey?: string;
    },
  ): Promise<void>;
  getConditionalCalendarMutationTarget(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
    },
  ): Promise<LifeOpsCalendarEvent>;
  respondToCalendarEvent(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      responseStatus: "accepted" | "declined" | "tentative";
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
    },
  ): Promise<LifeOpsCalendarEvent>;
  reserveTravelBuffer(request: {
    eventId: string;
    bufferMinutes: number;
    method: string;
  }): Promise<LifeOpsCalendarEvent>;
  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsNextCalendarEventContext>;
}
