/**
 * Calendar mixin — thin delegation shim.
 *
 * The calendar domain (feed sync, event CRUD, aggregation, next-event context,
 * reminder-plan scheduling for events) was extracted into the first-class
 * `@elizaos/plugin-calendar` package as `CalendarService`. This mixin keeps the
 * `LifeOpsService.<calendar>` method surface that LifeOps actions, routes,
 * providers, briefs, travel, and activity tracking already call, delegating
 * each call to the singleton `CalendarService`.
 *
 * LifeOps injects a `CalendarHostGate` into the service at init (see
 * `calendar-gate.ts`) so calendar events keep firing reminders and writing
 * audit rows through the LifeOps repository.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { CalendarService } from "@elizaos/plugin-calendar";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
} from "@elizaos/shared";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import { LifeOpsServiceError } from "./service-types.js";

export interface LifeOpsCalendarService {
  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]>;
  setCalendarIncluded(
    requestUrl: URL,
    request: {
      calendarId: string;
      includeInFeed: boolean;
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
    },
  ): Promise<LifeOpsCalendarSummary>;
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
    },
  ): Promise<void>;
  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsNextCalendarEventContext>;
}

function resolveCalendarService(runtime: IAgentRuntime): CalendarService {
  const service = runtime.getService(
    CalendarService.serviceType,
  ) as CalendarService | null;
  if (!service) {
    throw new LifeOpsServiceError(
      503,
      "Calendar service is unavailable. Ensure @elizaos/plugin-calendar is registered.",
    );
  }
  return service;
}

/** @internal */
export function withCalendar<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsCalendarService> {
  const CalendarBase = Base as unknown as Constructor<LifeOpsServiceBase>;
  return class extends CalendarBase {
    listCalendars(
      requestUrl: URL,
      request?: ListLifeOpsCalendarsRequest,
    ): Promise<LifeOpsCalendarSummary[]> {
      return resolveCalendarService(this.runtime).listCalendars(
        requestUrl,
        request,
      );
    }

    setCalendarIncluded(
      requestUrl: URL,
      request: {
        calendarId: string;
        includeInFeed: boolean;
        side?: LifeOpsConnectorSide;
        mode?: LifeOpsConnectorMode;
        grantId?: string;
      },
    ): Promise<LifeOpsCalendarSummary> {
      return resolveCalendarService(this.runtime).setCalendarIncluded(
        requestUrl,
        request,
      );
    }

    getCalendarFeed(
      requestUrl: URL,
      request?: GetLifeOpsCalendarFeedRequest,
      now?: Date,
    ): Promise<LifeOpsCalendarFeed> {
      return resolveCalendarService(this.runtime).getCalendarFeed(
        requestUrl,
        request,
        now,
      );
    }

    createCalendarEvent(
      requestUrl: URL,
      request: CreateLifeOpsCalendarEventRequest,
      now?: Date,
    ): Promise<LifeOpsCalendarEvent> {
      return resolveCalendarService(this.runtime).createCalendarEvent(
        requestUrl,
        request,
        now,
      );
    }

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
      },
    ): Promise<LifeOpsCalendarEvent> {
      return resolveCalendarService(this.runtime).updateCalendarEvent(
        requestUrl,
        request,
      );
    }

    deleteCalendarEvent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode | null;
        side?: LifeOpsConnectorSide | null;
        grantId?: string;
        calendarId?: string | null;
        eventId: string;
      },
    ): Promise<void> {
      return resolveCalendarService(this.runtime).deleteCalendarEvent(
        requestUrl,
        request,
      );
    }

    getNextCalendarEventContext(
      requestUrl: URL,
      request?: GetLifeOpsCalendarFeedRequest,
      now?: Date,
    ): Promise<LifeOpsNextCalendarEventContext> {
      return resolveCalendarService(this.runtime).getNextCalendarEventContext(
        requestUrl,
        request,
        now,
      );
    }
  } as unknown as MixinClass<TBase, LifeOpsCalendarService>;
}
