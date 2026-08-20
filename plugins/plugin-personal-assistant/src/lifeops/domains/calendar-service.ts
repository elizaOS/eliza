/**
 * Calendar domain sub-service — thin delegation onto the first-class
 * `@elizaos/plugin-calendar` `CalendarService`.
 *
 * The calendar domain (feed sync, event CRUD, aggregation, next-event context,
 * reminder-plan scheduling for events) lives in the `@elizaos/plugin-calendar`
 * package as `CalendarService`. This domain keeps the LifeOps method surface
 * that LifeOps actions, routes, providers, briefs, travel, and activity
 * tracking already call, delegating each call to the singleton
 * `CalendarService`.
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
import { settleBriefEngagementReward } from "../briefing/engagement-reward.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { LifeOpsServiceError } from "../service-types.js";

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

export class CalendarDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<LifeOpsCalendarSummary[]> {
    return resolveCalendarService(this.ctx.runtime).listCalendars(
      requestUrl,
      request,
    );
  }

  setCalendarIncluded(
    requestUrl: URL,
    request: SetLifeOpsCalendarIncludedRequest,
  ): Promise<SetLifeOpsCalendarIncludedResponse> {
    return resolveCalendarService(this.ctx.runtime).setCalendarIncluded(
      requestUrl,
      request,
    );
  }

  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarFeed> {
    return resolveCalendarService(this.ctx.runtime).getCalendarFeed(
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
    return resolveCalendarService(this.ctx.runtime).createCalendarEvent(
      requestUrl,
      request,
      now,
    );
  }

  createCalendarEventMutation(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
    now?: Date,
  ): Promise<CreateLifeOpsCalendarEventResponse> {
    return resolveCalendarService(this.ctx.runtime).createCalendarEventMutation(
      requestUrl,
      request,
      now,
    );
  }

  getAppleCalendarCreateAccess(): ReturnType<
    CalendarService["getAppleCalendarCreateAccess"]
  > {
    return resolveCalendarService(
      this.ctx.runtime,
    ).getAppleCalendarCreateAccess();
  }

  async updateCalendarEvent(
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
  ): Promise<LifeOpsCalendarEvent> {
    const event = await resolveCalendarService(
      this.ctx.runtime,
    ).updateCalendarEvent(requestUrl, request);
    if (request.startAt !== undefined || request.endAt !== undefined) {
      try {
        const eventAt = new Date(event.updatedAt).toISOString();
        if (!Number.isFinite(Date.parse(eventAt))) {
          throw new Error(
            `[CalendarDomain] Updated event ${event.id} has no authoritative mutation timestamp`,
          );
        }
        const engagement =
          await this.ctx.repository.attributeBriefItemEngagement({
            agentId: this.ctx.agentId(),
            source: "calendar",
            sourceId: event.id,
            eventType: "rescheduled",
            eventAt,
            domainEventId:
              request.idempotencyKey ??
              `calendar_rescheduled:${event.id}:${eventAt}`,
            weight: 1,
          });
        if (engagement) {
          await settleBriefEngagementReward({
            runtime: this.ctx.runtime,
            repository: this.ctx.repository,
            engagement,
          });
        }
      } catch (error) {
        // error-policy:J7 the provider mutation already committed; delayed
        // learning telemetry cannot rewrite its successful result.
        this.ctx.runtime.reportError(
          "CalendarDomain.attributeBriefReschedule",
          error,
          { eventId: event.id },
        );
      }
    }
    return event;
  }

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
  ): Promise<void> {
    return resolveCalendarService(this.ctx.runtime).deleteCalendarEvent(
      requestUrl,
      request,
    );
  }

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
  ): Promise<LifeOpsCalendarEvent> {
    return resolveCalendarService(
      this.ctx.runtime,
    ).getConditionalCalendarMutationTarget(requestUrl, request);
  }

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
  ): Promise<LifeOpsCalendarEvent> {
    return resolveCalendarService(this.ctx.runtime).respondToCalendarEvent(
      requestUrl,
      request,
    );
  }

  reserveTravelBuffer(request: {
    eventId: string;
    bufferMinutes: number;
    method: string;
  }): Promise<LifeOpsCalendarEvent> {
    return resolveCalendarService(this.ctx.runtime).reserveTravelBuffer(
      request,
    );
  }

  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsNextCalendarEventContext> {
    return resolveCalendarService(this.ctx.runtime).getNextCalendarEventContext(
      requestUrl,
      request,
      now,
    );
  }
}
