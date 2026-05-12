import type { FeatureResult } from "@elizaos/shared";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  LifeOpsNextCalendarEventContext,
  ListLifeOpsCalendarsRequest,
} from "../contracts/index.js";
import {
  APPLE_CALENDAR_GRANT_ID,
  APPLE_CALENDAR_PROVIDER,
  APPLE_CALENDAR_ACCOUNT_LABEL,
  createNativeAppleCalendarEvent,
  deleteNativeAppleCalendarEvent,
  getNativeAppleCalendarFeed,
  isAppleCalendarGrant,
  listNativeAppleCalendars,
  updateNativeAppleCalendarEvent,
} from "./apple-calendar.js";
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

type CalendarMixinDependencies = LifeOpsServiceBase & {
  getGoogleConnectorAccounts(
    requestUrl: URL,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  requireGoogleCalendarGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
};

type AppleCalendarFailure = Extract<FeatureResult<unknown>, { ok: false }>;

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

function hasGoogleConnectorGrant(
  status: LifeOpsGoogleConnectorStatus,
): status is LifeOpsGoogleConnectorStatus & { grant: LifeOpsConnectorGrant } {
  return status.grant !== null;
}

function isAppleCalendarFailure(
  result: FeatureResult<unknown>,
): result is AppleCalendarFailure {
  return result.ok === false;
}

function failAppleCalendarResult(
  result: FeatureResult<unknown>,
  operation: string,
): never {
  if (!isAppleCalendarFailure(result)) {
    fail(500, `Apple Calendar ${operation} unexpectedly succeeded.`);
  }
  if (result.reason === "permission") {
    fail(
      403,
      `Apple Calendar permission is required for ${operation}. Grant Calendar access to continue.`,
    );
  }
  if (result.reason === "not_supported") {
    fail(
      409,
      `Apple Calendar is not available on ${result.platform}; connect Google Calendar or use a native Apple platform.`,
    );
  }
  if (
    result.reason === "native_error" &&
    /attendee|invitee|invited meeting/i.test(result.message ?? "")
  ) {
    fail(
      409,
      result.message ||
        "Apple Calendar cannot create or edit invited meetings. Connect Google Calendar or remove attendees.",
    );
  }
  fail(
    502,
    result.reason === "native_error" && result.message
      ? result.message
      : `Apple Calendar ${operation} failed through EventKit.`,
  );
}

function appleCalendarPlaceholderSummary(args: {
  calendarId?: string | null;
  timeZone?: string | null;
  side?: LifeOpsConnectorSide | null;
}): LifeOpsCalendarSummary {
  const calendarId = args.calendarId?.trim() || "primary";
  return {
    provider: APPLE_CALENDAR_PROVIDER,
    side: args.side ?? "owner",
    grantId: APPLE_CALENDAR_GRANT_ID,
    accountEmail: null,
    calendarId,
    summary:
      calendarId === "primary" ? APPLE_CALENDAR_ACCOUNT_LABEL : calendarId,
    description: null,
    primary: calendarId === "primary",
    accessRole: "writer",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: args.timeZone ?? null,
    selected: true,
    includeInFeed: true,
  };
}

function shouldIncludeAppleCalendar(request: {
  mode?: LifeOpsConnectorMode | null;
  side?: LifeOpsConnectorSide | null;
  grantId?: string | null;
}): boolean {
  if (request.mode && request.mode !== "local") return false;
  if (request.side && request.side !== "owner") return false;
  if (request.grantId && !isAppleCalendarGrant(request.grantId)) return false;
  return true;
}

/** @internal */
export function withCalendar<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsCalendarService> {
  const CalendarBase =
    Base as unknown as Constructor<CalendarMixinDependencies>;

  return class extends CalendarBase {
    public async listCalendars(
      requestUrl: URL,
      request?: ListLifeOpsCalendarsRequest,
    ): Promise<LifeOpsCalendarSummary[]> {
      const mode = normalizeOptionalConnectorMode(request?.mode, "mode");
      const side = normalizeOptionalConnectorSide(request?.side, "side");
      const statuses = await this.getGoogleConnectorAccounts(requestUrl, side);
      const grants = statuses
        .filter(hasGoogleConnectorGrant)
        .map((status) => status.grant)
        .filter((grant) =>
          request?.grantId ? grant.id === request.grantId : true,
        )
        .filter((grant) => (mode ? grant.mode === mode : true))
        .filter((grant) => grant.capabilities.includes("google.calendar.read"));
      const summaries: LifeOpsCalendarSummary[] = [];
      if (grants.length > 0) {
        const listCalendars = requireGoogleServiceMethod(this.runtime, "listCalendars");
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
      }
      if (shouldIncludeAppleCalendar({ mode, side, grantId: request?.grantId })) {
        const appleCalendars = await listNativeAppleCalendars({
          agentId: this.agentId(),
          side: "owner",
          runtime: this.runtime,
        });
        if (appleCalendars.ok) {
          summaries.push(...appleCalendars.data);
        }
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
      const existingEventsForCalendar = existingEvents.filter(
        (event) =>
          event.grantId === grant.id && event.calendarId === args.calendarId,
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
      const removedEventIds = existingEventsForCalendar
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

    public async syncAppleCalendarFeed(args: {
      calendarId: string;
      timeMin: string;
      timeMax: string;
      timeZone: string;
    }): Promise<LifeOpsCalendarFeed> {
      const syncedAt = new Date().toISOString();
      const existingEvents = await this.repository.listCalendarEvents(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        args.timeMin,
        args.timeMax,
        "owner",
      );
      const existingEventsForCalendar =
        args.calendarId === "all"
          ? existingEvents
          : existingEvents.filter(
              (event) => event.calendarId === args.calendarId,
            );
      const nativeFeed = await getNativeAppleCalendarFeed({
        agentId: this.agentId(),
        calendarId: args.calendarId === "all" ? null : args.calendarId,
        timeMin: args.timeMin,
        timeMax: args.timeMax,
        side: "owner",
        runtime: this.runtime,
      });
      if (!nativeFeed.ok) {
        failAppleCalendarResult(nativeFeed, "feed");
      }
      const nextEvents = nativeFeed.data.events.map((event) => ({
        ...event,
        syncedAt,
        updatedAt: syncedAt,
      }));
      const nextEventIds = new Set(nextEvents.map((event) => event.id));
      const removedEventIds = existingEventsForCalendar
        .map((event) => event.id)
        .filter((eventId) => !nextEventIds.has(eventId));

      await this.repository.pruneCalendarEventsInWindow(
        this.agentId(),
        APPLE_CALENDAR_PROVIDER,
        args.calendarId,
        args.timeMin,
        args.timeMax,
        nextEvents.map((event) => event.externalId),
        "owner",
      );
      await this.deleteCalendarReminderPlansForEvents(removedEventIds);
      for (const event of nextEvents) {
        await this.repository.upsertCalendarEvent(event, "owner");
      }
      await this.syncCalendarReminderPlans(nextEvents);
      await this.repository.upsertCalendarSyncState(
        createLifeOpsCalendarSyncState({
          agentId: this.agentId(),
          provider: APPLE_CALENDAR_PROVIDER,
          side: "owner",
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
            isAppleCalendarGrant(request.grantId)
              ? appleCalendarPlaceholderSummary({
                  calendarId: normalizeCalendarId(explicitCalendarId),
                  timeZone,
                  side,
                })
              : ({
                  provider: "google",
                  side: side ?? "owner",
                  calendarId: normalizeCalendarId(explicitCalendarId),
                  grantId: request.grantId,
                  includeInFeed: true,
                  summary: explicitCalendarId,
                  accountEmail: null,
                } as LifeOpsCalendarSummary),
          ]
        : (await this.listCalendars(requestUrl, {
            mode,
            side,
            grantId: request.grantId,
          })).filter((calendar) => includeHiddenCalendars || calendar.includeInFeed);
      if (calendars.length === 0) {
        if (!explicitCalendarId && shouldIncludeAppleCalendar({ mode, side, grantId: request.grantId })) {
          const appleFeed = await this.syncAppleCalendarFeed({
            calendarId: "all",
            timeMin,
            timeMax,
            timeZone,
          });
          return appleFeed;
        }
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
        const feed =
          calendar.provider === APPLE_CALENDAR_PROVIDER
            ? await this.syncAppleCalendarFeed({
                calendarId: calendar.calendarId,
                timeMin,
                timeMax,
                timeZone,
              })
            : await this.syncGoogleCalendarFeed({
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

    public async findCachedCalendarEventOwnerIds(args: {
      provider: "google" | typeof APPLE_CALENDAR_PROVIDER;
      externalEventId: string;
      calendarId?: string | null;
      side: LifeOpsConnectorSide;
      grantId?: string | null;
    }): Promise<string[]> {
      const events = await this.repository.listCalendarEvents(
        this.agentId(),
        args.provider,
        undefined,
        undefined,
        args.side,
      );
      return events
        .filter((event) => event.externalId === args.externalEventId)
        .filter((event) =>
          args.calendarId && args.calendarId !== "all"
            ? event.calendarId === args.calendarId
            : true,
        )
        .filter((event) =>
          args.grantId ? event.grantId === args.grantId : true,
        )
        .map((event) => event.id);
    }

    async createCalendarEvent(
      requestUrl: URL,
      request: CreateLifeOpsCalendarEventRequest,
      now = new Date(),
    ): Promise<LifeOpsCalendarEvent> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const calendarId = normalizeCalendarId(request.calendarId);
      const { startAt, endAt, timeZone } = resolveCalendarEventRange(
        request,
        now,
      );
      if (isAppleCalendarGrant(request.grantId)) {
        const nativeEvent = await createNativeAppleCalendarEvent({
          agentId: this.agentId(),
          request: {
            ...request,
            calendarId,
            startAt,
            endAt,
            timeZone,
          },
          side: "owner",
          runtime: this.runtime,
        });
        if (!nativeEvent.ok) {
          failAppleCalendarResult(nativeEvent, "create");
        }
        await this.repository.upsertCalendarEvent(nativeEvent.data, "owner");
        await this.syncCalendarReminderPlans([nativeEvent.data]);
        await this.recordCalendarEventAudit(
          nativeEvent.data.id,
          "calendar event created through native Apple Calendar",
          { calendarId, title: request.title },
          { externalId: nativeEvent.data.externalId },
        );
        return nativeEvent.data;
      }

      let grant: LifeOpsConnectorGrant;
      try {
        grant = await this.requireGoogleCalendarWriteGrant(
          requestUrl,
          mode,
          side,
          request.grantId,
        );
      } catch (error) {
        if (request.grantId) {
          throw error;
        }
        const nativeEvent = await createNativeAppleCalendarEvent({
          agentId: this.agentId(),
          request: {
            ...request,
            calendarId,
            startAt,
            endAt,
            timeZone,
          },
          side: "owner",
          runtime: this.runtime,
        });
        if (!nativeEvent.ok) {
          failAppleCalendarResult(nativeEvent, "create");
        }
        await this.repository.upsertCalendarEvent(nativeEvent.data, "owner");
        await this.syncCalendarReminderPlans([nativeEvent.data]);
        await this.recordCalendarEventAudit(
          nativeEvent.data.id,
          "calendar event created through native Apple Calendar",
          { calendarId, title: request.title },
          { externalId: nativeEvent.data.externalId },
        );
        return nativeEvent.data;
      }
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
      const timeZone = request.timeZone
        ? normalizeCalendarTimeZone(request.timeZone)
        : undefined;
      const parseTimeZone = timeZone ?? normalizeCalendarTimeZone(undefined);
      const nativePatch = {
        calendarId: request.calendarId ?? undefined,
        title: request.title,
        description: request.description,
        location: request.location,
        startAt: request.startAt
          ? normalizeCalendarDateTimeInTimeZone(request.startAt, "startAt", parseTimeZone)
          : undefined,
        endAt: request.endAt
          ? normalizeCalendarDateTimeInTimeZone(request.endAt, "endAt", parseTimeZone)
          : undefined,
        timeZone,
        attendees:
          request.attendees === undefined
            ? undefined
            : normalizeCalendarAttendees(request.attendees),
      };
      if (isAppleCalendarGrant(request.grantId)) {
        const nativeEvent = await updateNativeAppleCalendarEvent({
          agentId: this.agentId(),
          eventId: requireNonEmptyString(request.eventId, "eventId"),
          request: nativePatch,
          side: "owner",
          runtime: this.runtime,
        });
        if (!nativeEvent.ok) {
          failAppleCalendarResult(nativeEvent, "update");
        }
        await this.repository.upsertCalendarEvent(nativeEvent.data, "owner");
        await this.syncCalendarReminderPlans([nativeEvent.data]);
        await this.recordCalendarEventAudit(
          nativeEvent.data.id,
          "calendar event updated through native Apple Calendar",
          { eventId: request.eventId },
          { externalId: nativeEvent.data.externalId },
          "calendar_event_updated",
        );
        return nativeEvent.data;
      }

      let grant: LifeOpsConnectorGrant;
      try {
        grant = await this.requireGoogleCalendarWriteGrant(
          requestUrl,
          mode,
          side,
          request.grantId,
        );
      } catch (error) {
        if (request.grantId) {
          throw error;
        }
        const nativeEvent = await updateNativeAppleCalendarEvent({
          agentId: this.agentId(),
          eventId: requireNonEmptyString(request.eventId, "eventId"),
          request: nativePatch,
          side: "owner",
          runtime: this.runtime,
        });
        if (!nativeEvent.ok) {
          failAppleCalendarResult(nativeEvent, "update");
        }
        await this.repository.upsertCalendarEvent(nativeEvent.data, "owner");
        await this.syncCalendarReminderPlans([nativeEvent.data]);
        await this.recordCalendarEventAudit(
          nativeEvent.data.id,
          "calendar event updated through native Apple Calendar",
          { eventId: request.eventId },
          { externalId: nativeEvent.data.externalId },
          "calendar_event_updated",
        );
        return nativeEvent.data;
      }
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
            ? normalizeCalendarDateTimeInTimeZone(request.startAt, "startAt", parseTimeZone)
            : undefined,
          endAt: request.endAt
            ? normalizeCalendarDateTimeInTimeZone(request.endAt, "endAt", parseTimeZone)
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
      const eventId = requireNonEmptyString(request.eventId, "eventId");
      if (isAppleCalendarGrant(request.grantId)) {
        const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
          provider: APPLE_CALENDAR_PROVIDER,
          externalEventId: eventId,
          calendarId: request.calendarId,
          side: "owner",
          grantId: APPLE_CALENDAR_GRANT_ID,
        });
        const deleted = await deleteNativeAppleCalendarEvent(eventId, {
          runtime: this.runtime,
        });
        if (!deleted.ok) {
          failAppleCalendarResult(deleted, "delete");
        }
        await this.repository.deleteCalendarEventByExternalId(
          this.agentId(),
          APPLE_CALENDAR_PROVIDER,
          request.calendarId,
          eventId,
          "owner",
        );
        await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
        await this.recordCalendarEventAudit(
          eventId,
          "calendar event deleted through native Apple Calendar",
          { eventId },
          { deleted: true },
          "calendar_event_deleted",
        );
        return;
      }

      let grant: LifeOpsConnectorGrant;
      try {
        grant = await this.requireGoogleCalendarWriteGrant(
          requestUrl,
          mode,
          side,
          request.grantId,
        );
      } catch (error) {
        if (request.grantId) {
          throw error;
        }
        const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
          provider: APPLE_CALENDAR_PROVIDER,
          externalEventId: eventId,
          calendarId: request.calendarId,
          side: "owner",
          grantId: APPLE_CALENDAR_GRANT_ID,
        });
        const deleted = await deleteNativeAppleCalendarEvent(eventId, {
          runtime: this.runtime,
        });
        if (!deleted.ok) {
          failAppleCalendarResult(deleted, "delete");
        }
        await this.repository.deleteCalendarEventByExternalId(
          this.agentId(),
          APPLE_CALENDAR_PROVIDER,
          request.calendarId,
          eventId,
          "owner",
        );
        await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
        await this.recordCalendarEventAudit(
          eventId,
          "calendar event deleted through native Apple Calendar",
          { eventId },
          { deleted: true },
          "calendar_event_deleted",
        );
        return;
      }
      const deleteEvent = requireGoogleServiceMethod(this.runtime, "deleteEvent");
      await deleteEvent({
        accountId: accountIdForGrant(grant),
        calendarId: request.calendarId ?? undefined,
        eventId,
      });
      const cachedOwnerIds = await this.findCachedCalendarEventOwnerIds({
        provider: "google",
        externalEventId: eventId,
        calendarId: request.calendarId,
        side: grant.side,
        grantId: grant.id,
      });
      await this.repository.deleteCalendarEventByExternalId(
        this.agentId(),
        "google",
        request.calendarId,
        eventId,
        grant.side,
      );
      await this.deleteCalendarReminderPlansForEvents(cachedOwnerIds);
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
  } as unknown as MixinClass<TBase, LifeOpsCalendarService>;
}
