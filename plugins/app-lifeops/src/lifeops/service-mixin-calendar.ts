// @ts-nocheck — Mixin pattern: see service.ts for the composed public type.
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
} from "../contracts/index.js";
import {
  accountIdForGrant,
  googleCalendarEventInput,
  googleCalendarEventPatchInput,
  lifeOpsCalendarEventFromGoogle,
  lifeOpsCalendarSummaryFromGoogle,
  requireGoogleServiceMethod,
} from "./google-plugin-delegates.js";
import {
  calendarFeedPreferenceKey,
  ensureLifeOpsCalendarFeedIncludes,
  setLifeOpsCalendarFeedIncluded,
} from "./owner-profile.js";
import {
  createLifeOpsAuditEvent,
  createLifeOpsCalendarSyncState,
  createLifeOpsReminderPlan,
} from "./repository.js";
import { DEFAULT_CALENDAR_REMINDER_STEPS } from "./service-constants.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  buildNextCalendarEventContext,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "./service-normalize-calendar.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
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

type AggregatedCalendarFeedSource = {
  calendar: Pick<
    LifeOpsCalendarSummary,
    "accountEmail" | "calendarId" | "grantId" | "summary"
  >;
  feed: LifeOpsCalendarFeed;
};

export function mergeAggregatedCalendarFeedEvents(
  sources: readonly AggregatedCalendarFeedSource[],
): LifeOpsCalendarEvent[] {
  const dedupedEvents = new Map<string, LifeOpsCalendarEvent>();
  for (const source of sources) {
    for (const event of source.feed.events) {
      if (dedupedEvents.has(event.id)) {
        continue;
      }
      dedupedEvents.set(event.id, {
        ...event,
        grantId: event.grantId ?? source.calendar.grantId,
        accountEmail:
          event.accountEmail ?? source.calendar.accountEmail ?? undefined,
        calendarSummary: event.calendarSummary ?? source.calendar.summary,
      });
    }
  }
  return [...dedupedEvents.values()].sort((a, b) =>
    a.startAt.localeCompare(b.startAt),
  );
}

/** @internal */
export function withCalendar<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsCalendarService> {
  return class extends Base {
    public async listCalendars(
      requestUrl: URL,
      request?: ListLifeOpsCalendarsRequest,
    ): Promise<LifeOpsCalendarSummary[]> {
      const mode = normalizeOptionalConnectorMode(request?.mode, "mode");
      const side = normalizeOptionalConnectorSide(request?.side, "side");
      const statuses = await this.getGoogleConnectorAccounts(requestUrl, side);
      const grants = statuses
        .map((status) => status.grant)
        .filter(Boolean)
        .filter((grant) =>
          request?.grantId ? grant.id === request.grantId : true,
        )
        .filter((grant) => (mode ? grant.mode === mode : true))
        .filter((grant) => grant.capabilities.includes("google.calendar.read"));
      const listCalendars = requireGoogleServiceMethod(this.runtime, "listCalendars");
      const summaries: LifeOpsCalendarSummary[] = [];
      for (const grant of grants) {
        const entries = await listCalendars({
          accountId: accountIdForGrant(grant),
        });
        summaries.push(
          ...entries.map((entry) =>
            lifeOpsCalendarSummaryFromGoogle({ entry, grant }),
          ),
        );
      }
      const preferences = await ensureLifeOpsCalendarFeedIncludes(
        this.runtime,
        summaries.map((summary) => ({
          grantId: summary.grantId,
          calendarId: summary.calendarId,
        })),
      );
      return summaries.map((summary) => ({
        ...summary,
        includeInFeed:
          preferences.calendarFeedIncludes[
            calendarFeedPreferenceKey(summary.grantId, summary.calendarId)
          ] !== false,
      }));
    }

    public async setCalendarIncluded(
      requestUrl: URL,
      request: {
        calendarId: string;
        includeInFeed: boolean;
        side?: LifeOpsConnectorSide;
        mode?: LifeOpsConnectorMode;
        grantId?: string;
      },
    ): Promise<LifeOpsCalendarSummary> {
      const calendarId = requireNonEmptyString(request.calendarId, "calendarId");
      const includeInFeed = normalizeOptionalBoolean(
        request.includeInFeed,
        "includeInFeed",
      );
      if (includeInFeed === undefined) {
        throw new LifeOpsServiceError(400, "includeInFeed must be a boolean");
      }
      const calendars = await this.listCalendars(requestUrl, request);
      const calendar = calendars.find(
        (entry) =>
          entry.calendarId === calendarId &&
          (request.grantId ? entry.grantId === request.grantId : true),
      );
      if (!calendar) {
        throw new LifeOpsServiceError(404, "Calendar not found");
      }
      await setLifeOpsCalendarFeedIncluded(
        this.runtime,
        { grantId: calendar.grantId, calendarId },
        includeInFeed,
      );
      return { ...calendar, includeInFeed };
    }

    public async recordCalendarEventAudit(
      ownerId: string,
      reason: string,
      inputs: Record<string, unknown>,
      decision: Record<string, unknown>,
      eventType:
        | "calendar_event_created"
        | "calendar_event_updated"
        | "calendar_event_deleted" = "calendar_event_created",
    ): Promise<void> {
      await this.repository.createAuditEvent(
        createLifeOpsAuditEvent({
          agentId: this.agentId(),
          eventType,
          ownerType: "calendar_event",
          ownerId,
          reason,
          inputs,
          decision,
          actor: "user",
        }),
      );
    }

    public async syncCalendarReminderPlans(
      events: LifeOpsCalendarEvent[],
    ): Promise<void> {
      const eventIds = events.map((event) => event.id);
      const existingPlans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        eventIds,
      );
      const plansByOwnerId = new Map(
        existingPlans.map((plan) => [plan.ownerId, plan]),
      );
      for (const event of events) {
        const existing = plansByOwnerId.get(event.id);
        if (existing) {
          await this.repository.updateReminderPlan({
            ...existing,
            steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        await this.repository.createReminderPlan(
          createLifeOpsReminderPlan({
            agentId: this.agentId(),
            ownerType: "calendar_event",
            ownerId: event.id,
            steps: DEFAULT_CALENDAR_REMINDER_STEPS.map((step) => ({ ...step })),
            mutePolicy: {},
            quietHours: {},
          }),
        );
      }
    }

    public async deleteCalendarReminderPlansForEvents(
      eventIds: string[],
    ): Promise<void> {
      if (eventIds.length === 0) {
        return;
      }
      const plans = await this.repository.listReminderPlansForOwners(
        this.agentId(),
        "calendar_event",
        eventIds,
      );
      for (const plan of plans) {
        await this.repository.deleteReminderPlan(this.agentId(), plan.id);
      }
    }

    public async syncGoogleCalendarFeed(args: {
      requestUrl: URL;
      requestedMode?: LifeOpsConnectorMode;
      requestedSide?: LifeOpsConnectorSide;
      grantId?: string;
      calendarId: string;
      timeMin: string;
      timeMax: string;
      timeZone: string;
    }): Promise<LifeOpsCalendarFeed> {
      const grant = await this.requireGoogleCalendarGrant(
        args.requestUrl,
        args.requestedMode,
        args.requestedSide,
        args.grantId,
      );
      const syncedAt = new Date().toISOString();
      const existingEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        "google",
        args.timeMin,
        args.timeMax,
        grant.side,
      );
      const listEvents = requireGoogleServiceMethod(this.runtime, "listEvents");
      const googleEvents = await listEvents({
        accountId: accountIdForGrant(grant),
        calendarId: args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        limit: 2500,
      });
      const nextEvents = googleEvents.map((event) =>
        lifeOpsCalendarEventFromGoogle({
          event,
          grant,
          agentId: this.agentId(),
          syncedAt,
        }),
      );
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      const removedEventIds = existingEvents
        .map((event) => event.id)
        .filter((eventId) => !nextEventIds.has(eventId));

      await this.repository.pruneCalendarEventsInWindow(
        this.agentId(),
        "google",
        args.calendarId,
        args.timeMin,
        args.timeMax,
        googleEvents.map((event) => event.id),
        grant.side,
      );
      await this.deleteCalendarReminderPlansForEvents(removedEventIds);
      for (const event of nextEvents) {
        await this.repository.upsertCalendarEvent(event, grant.side);
      }
      await this.syncCalendarReminderPlans(nextEvents);
      await this.repository.upsertCalendarSyncState(
        createLifeOpsCalendarSyncState({
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          grantId: grant.id,
          calendarId: args.calendarId,
          windowStartAt: args.timeMin,
          windowEndAt: args.timeMax,
          syncedAt,
        }),
      );
      return {
        calendarId: args.calendarId,
        events: nextEvents,
        source: "synced",
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        syncedAt,
      };
    }

    async getCalendarFeed(
      requestUrl: URL,
      request: GetLifeOpsCalendarFeedRequest = {},
      now = new Date(),
    ): Promise<LifeOpsCalendarFeed> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const explicitCalendarId = normalizeOptionalString(request.calendarId);
      const includeHiddenCalendars =
        normalizeOptionalBoolean(
          request.includeHiddenCalendars,
          "includeHiddenCalendars",
        ) ?? false;
      const timeZone = normalizeCalendarTimeZone(request.timeZone);
      const { timeMin, timeMax } = resolveCalendarWindow({
        now,
        timeZone,
        requestedTimeMin: request.timeMin,
        requestedTimeMax: request.timeMax,
      });
      const forceSync =
        normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;

      const calendars = explicitCalendarId
        ? [
            {
              calendarId: normalizeCalendarId(explicitCalendarId),
              grantId: request.grantId,
              includeInFeed: true,
              summary: explicitCalendarId,
              accountEmail: null,
            } as LifeOpsCalendarSummary,
          ]
        : (await this.listCalendars(requestUrl, {
            mode,
            side,
            grantId: request.grantId,
          })).filter((calendar) => includeHiddenCalendars || calendar.includeInFeed);
      if (calendars.length === 0) {
        return {
          calendarId: explicitCalendarId ?? "all",
          events: [],
          source: "cache",
          timeMin,
          timeMax,
          syncedAt: null,
        };
      }
      return this.aggregateCalendarFeedsAcrossCalendars(
        requestUrl,
        calendars,
        timeMin,
        timeMax,
        timeZone,
        forceSync,
        now,
      );
    }

    public async aggregateCalendarFeedsAcrossCalendars(
      requestUrl: URL,
      calendars: LifeOpsCalendarSummary[],
      timeMin: string,
      timeMax: string,
      timeZone: string,
      forceSync: boolean,
      now = new Date(),
    ): Promise<LifeOpsCalendarFeed> {
      const sources: AggregatedCalendarFeedSource[] = [];
      for (const calendar of calendars) {
        const feed = await this.syncGoogleCalendarFeed({
          requestUrl,
          requestedSide: calendar.side,
          grantId: calendar.grantId,
          calendarId: calendar.calendarId,
          timeMin,
          timeMax,
          timeZone,
        });
        sources.push({ calendar, feed });
      }
      return {
        calendarId: calendars.length === 1 ? calendars[0].calendarId : "all",
        events: mergeAggregatedCalendarFeedEvents(sources),
        source: forceSync ? "synced" : "synced",
        timeMin,
        timeMax,
        syncedAt: new Date(now).toISOString(),
      };
    }

    public async aggregateCalendarFeeds(
      requestUrl: URL,
      grants: readonly { id: string; side: LifeOpsConnectorSide }[],
      calendarId: string,
      timeMin: string,
      timeMax: string,
      timeZone: string,
      forceSync: boolean,
      now = new Date(),
    ): Promise<LifeOpsCalendarFeed> {
      const calendars = grants.map(
        (grant) =>
          ({
            provider: "google",
            side: grant.side,
            grantId: grant.id,
            accountEmail: null,
            calendarId,
            summary: calendarId,
            description: null,
            primary: calendarId === "primary",
            accessRole: "reader",
            backgroundColor: null,
            foregroundColor: null,
            timeZone,
            selected: true,
            includeInFeed: true,
          }) as LifeOpsCalendarSummary,
      );
      return this.aggregateCalendarFeedsAcrossCalendars(
        requestUrl,
        calendars,
        timeMin,
        timeMax,
        timeZone,
        forceSync,
        now,
      );
    }

    async createCalendarEvent(
      requestUrl: URL,
      request: CreateLifeOpsCalendarEventRequest,
      now = new Date(),
    ): Promise<LifeOpsCalendarEvent> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const calendarId = normalizeCalendarId(request.calendarId);
      const timeZone = normalizeCalendarTimeZone(request.timeZone);
      const { startAt, endAt } = resolveCalendarEventRange(request, now, timeZone);
      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const createEvent = requireGoogleServiceMethod(this.runtime, "createEvent");
      const googleEvent = await createEvent(
        googleCalendarEventInput({
          accountId: accountIdForGrant(grant),
          calendarId,
          title: requireNonEmptyString(request.title, "title"),
          startAt,
          endAt,
          timeZone,
          description: normalizeOptionalString(request.description),
          location: normalizeOptionalString(request.location),
          attendees: normalizeCalendarAttendees(request.attendees),
        }),
      );
      const event = lifeOpsCalendarEventFromGoogle({
        event: googleEvent,
        grant,
        agentId: this.agentId(),
      });
      await this.repository.upsertCalendarEvent(event, grant.side);
      await this.syncCalendarReminderPlans([event]);
      await this.recordCalendarEventAudit(
        event.id,
        "calendar event created through plugin-google",
        { calendarId, title: request.title },
        { externalId: event.externalId },
      );
      return event;
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
      },
    ): Promise<LifeOpsCalendarEvent> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const timeZone = request.timeZone
        ? normalizeCalendarTimeZone(request.timeZone)
        : undefined;
      const updateEvent = requireGoogleServiceMethod(this.runtime, "updateEvent");
      const googleEvent = await updateEvent(
        googleCalendarEventPatchInput({
          accountId: accountIdForGrant(grant),
          calendarId: request.calendarId,
          eventId: requireNonEmptyString(request.eventId, "eventId"),
          title: request.title,
          description: request.description,
          location: request.location,
          startAt: request.startAt
            ? normalizeCalendarDateTimeInTimeZone(request.startAt, timeZone)
            : undefined,
          endAt: request.endAt
            ? normalizeCalendarDateTimeInTimeZone(request.endAt, timeZone)
            : undefined,
          timeZone,
          attendees:
            request.attendees === undefined
              ? undefined
              : normalizeCalendarAttendees(request.attendees),
        }),
      );
      const event = lifeOpsCalendarEventFromGoogle({
        event: googleEvent,
        grant,
        agentId: this.agentId(),
      });
      await this.repository.upsertCalendarEvent(event, grant.side);
      await this.syncCalendarReminderPlans([event]);
      await this.recordCalendarEventAudit(
        event.id,
        "calendar event updated through plugin-google",
        { eventId: request.eventId },
        { externalId: event.externalId },
        "calendar_event_updated",
      );
      return event;
    }

    async deleteCalendarEvent(
      requestUrl: URL,
      request: {
        mode?: LifeOpsConnectorMode | null;
        side?: LifeOpsConnectorSide | null;
        grantId?: string;
        calendarId?: string | null;
        eventId: string;
      },
    ): Promise<void> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const eventId = requireNonEmptyString(request.eventId, "eventId");
      const deleteEvent = requireGoogleServiceMethod(this.runtime, "deleteEvent");
      await deleteEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId,
      });
      await this.repository.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        request.calendarId ?? "primary",
        eventId,
        grant.side,
      );
      await this.deleteCalendarReminderPlansForEvents([eventId]);
      await this.recordCalendarEventAudit(
        eventId,
        "calendar event deleted through plugin-google",
        { eventId },
        { deleted: true },
        "calendar_event_deleted",
      );
    }

    async getNextCalendarEventContext(
      requestUrl: URL,
      request: GetLifeOpsCalendarFeedRequest = {},
      now = new Date(),
    ): Promise<LifeOpsNextCalendarEventContext> {
      const timeZone = normalizeCalendarTimeZone(request.timeZone);
      const { timeMin, timeMax } = resolveNextCalendarEventWindow({ now, timeZone });
      const feed = await this.getCalendarFeed(
        requestUrl,
        {
          ...request,
          timeMin,
          timeMax,
          includeHiddenCalendars: false,
        },
        now,
      );
      const nextEvent =
        feed.events.find((event) => Date.parse(event.endAt) >= now.getTime()) ??
        null;
      return buildNextCalendarEventContext(nextEvent, now);
    }
  } as MixinClass<TBase, LifeOpsCalendarService>;
}
