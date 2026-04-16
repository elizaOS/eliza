// @ts-nocheck — mixin: type safety is enforced on the composed class
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared/contracts/lifeops";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  fetchGoogleCalendarEvent,
  fetchGoogleCalendarEvents,
  updateGoogleCalendarEvent,
} from "./google-calendar.js";
import {
  resolveGoogleExecutionTarget,
  resolveGoogleGrants,
} from "./google-connector-gateway.js";
import {
  ensureFreshGoogleAccessToken,
} from "./google-oauth.js";
import {
  createLifeOpsAuditEvent,
  createLifeOpsCalendarSyncState,
  createLifeOpsReminderPlan,
} from "./repository.js";
import {
  fail,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  createCalendarEventId,
  isCalendarSyncStateFresh,
} from "./service-normalize-gmail.js";
import {
  buildNextCalendarEventContext,
  hasGoogleGmailTriageCapability,
  normalizeCalendarAttendees,
  normalizeCalendarDateTimeInTimeZone,
  normalizeCalendarId,
  normalizeCalendarTimeZone,
  resolveCalendarEventRange,
  resolveCalendarWindow,
  resolveNextCalendarEventWindow,
} from "./service-normalize-calendar.js";
import {
  findLinkedMailForCalendarEvent,
} from "./service-normalize-gmail.js";
import {
  DEFAULT_CALENDAR_REMINDER_STEPS,
} from "./service-constants.js";
import {
  normalizeOptionalBoolean,
} from "./service-normalize.js";
import { LifeOpsServiceError } from "./service-types.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

const DEFAULT_GMAIL_TRIAGE_MAX_RESULTS = 12;

/** @internal */
export function withCalendar<TBase extends Constructor<LifeOpsServiceBase>>(Base: TBase) {
  class LifeOpsCalendarServiceMixin extends Base {

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
          const sameSteps =
            JSON.stringify(existing.steps) ===
            JSON.stringify(DEFAULT_CALENDAR_REMINDER_STEPS);
          if (sameSteps) {
            continue;
          }
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
      const syncCalendar = async (): Promise<LifeOpsCalendarFeed> => {
        const syncedAt = new Date().toISOString();
        const existingEvents = await this.repository.listCalendarEvents(
          this.agentId(),
          "google",
          args.timeMin,
          args.timeMax,
          grant.side,
        );
        const events =
          resolveGoogleExecutionTarget(grant) === "cloud"
            ? (
                await this.googleManagedClient.getCalendarFeed({
                  side: grant.side,
                  grantId: grant.id,
                  calendarId: args.calendarId,
                  timeMin: args.timeMin,
                  timeMax: args.timeMax,
                  timeZone: args.timeZone,
                })
              ).events
            : await fetchGoogleCalendarEvents({
                accessToken: (
                  await ensureFreshGoogleAccessToken(
                    grant.tokenRef ??
                      fail(409, "Google Calendar token reference is missing."),
                  )
                ).accessToken,
                calendarId: args.calendarId,
                timeMin: args.timeMin,
                timeMax: args.timeMax,
                timeZone: args.timeZone,
              });
        const nextEvents = events.map((event) => ({
          id: createCalendarEventId(
            this.agentId(),
            "google",
            grant.side,
            event.calendarId,
            event.externalId,
          ),
          agentId: this.agentId(),
          provider: "google" as const,
          side: grant.side,
          ...event,
          syncedAt,
          updatedAt: syncedAt,
        }));
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
          events.map((event) => event.externalId),
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
        await this.clearGoogleGrantAuthFailure(grant);

        return {
          calendarId: args.calendarId,
          events: await this.repository.listCalendarEvents(
            this.agentId(),
            "google",
            args.timeMin,
            args.timeMax,
            grant.side,
          ),
          source: "synced",
          timeMin: args.timeMin,
          timeMax: args.timeMax,
          syncedAt,
        };
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, syncCalendar)
        : this.withGoogleGrantOperation(grant, syncCalendar);
    }

    async getCalendarFeed(
      requestUrl: URL,
      request: GetLifeOpsCalendarFeedRequest = {},
      now = new Date(),
    ): Promise<LifeOpsCalendarFeed> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const { grantId } = request;
      const calendarId = normalizeCalendarId(request.calendarId);
      const timeZone = normalizeCalendarTimeZone(request.timeZone);
      const { timeMin, timeMax } = resolveCalendarWindow({
        now,
        timeZone,
        requestedTimeMin: request.timeMin,
        requestedTimeMax: request.timeMax,
      });
      const forceSync =
        normalizeOptionalBoolean(request.forceSync, "forceSync") ?? false;

      // Multi-account aggregation: when no grantId specified, check if
      // there are multiple grants and aggregate from all of them.
      if (!grantId) {
        const allGrants = (
          await this.repository.listConnectorGrants(this.agentId())
        ).filter((g) => g.provider === "google");
        const grants = resolveGoogleGrants({
          grants: allGrants,
          requestedSide: side,
          requestedMode: mode,
        });
        if (grants.length > 1) {
          return this.aggregateCalendarFeeds(
            requestUrl, grants, calendarId, timeMin, timeMax, timeZone, forceSync, now,
          );
        }
      }

      const grant = await this.requireGoogleCalendarGrant(requestUrl, mode, side, grantId);
      const effectiveSide = grant.side;

      const syncState = await this.repository.getCalendarSyncState(
        this.agentId(),
        "google",
        calendarId,
        effectiveSide,
      );
      if (
        !forceSync &&
        syncState &&
        isCalendarSyncStateFresh({
          syncedAt: syncState.syncedAt,
          timeMin,
          timeMax,
          windowStartAt: syncState.windowStartAt,
          windowEndAt: syncState.windowEndAt,
          now,
        })
      ) {
        return {
          calendarId,
          events: await this.repository.listCalendarEvents(
            this.agentId(),
            "google",
            timeMin,
            timeMax,
            effectiveSide,
          ),
          source: "cache",
          timeMin,
          timeMax,
          syncedAt: syncState.syncedAt,
        };
      }

      return this.syncGoogleCalendarFeed({
        requestUrl,
        requestedMode: mode,
        requestedSide: effectiveSide,
        grantId: grant.id,
        calendarId,
        timeMin,
        timeMax,
        timeZone,
      });
    }

    public async aggregateCalendarFeeds(
      requestUrl: URL,
      grants: readonly LifeOpsConnectorGrant[],
      calendarId: string,
      timeMin: string,
      timeMax: string,
      timeZone: string,
      forceSync: boolean,
      now: Date,
    ): Promise<LifeOpsCalendarFeed> {
      const results = await Promise.allSettled(
        grants.map((grant) =>
          this.getCalendarFeed(requestUrl, {
            grantId: grant.id,
            calendarId,
            timeMin,
            timeMax,
            timeZone,
            forceSync,
          }, now).then((feed) => ({
            feed,
            grant,
          })),
        ),
      );

      const allEvents: LifeOpsCalendarEvent[] = [];
      let latestSyncedAt: string | null = null;
      let source: "cache" | "synced" = "cache";

      for (const result of results) {
        if (result.status === "rejected") {
          this.logLifeOpsWarn("calendar_feed_aggregate", `Grant failed: ${result.reason}`, {});
          continue;
        }
        const { feed, grant } = result.value;
        if (feed.source === "synced") {
          source = "synced";
        }
        if (
          feed.syncedAt &&
          (!latestSyncedAt || feed.syncedAt > latestSyncedAt)
        ) {
          latestSyncedAt = feed.syncedAt;
        }
        for (const event of feed.events) {
          allEvents.push({
            ...event,
            grantId: grant.id,
            accountEmail: grant.identityEmail ?? undefined,
          });
        }
      }

      allEvents.sort((a, b) => a.startAt.localeCompare(b.startAt));

      return {
        calendarId,
        events: allEvents,
        source,
        timeMin,
        timeMax,
        syncedAt: latestSyncedAt,
      };
    }

    async createCalendarEvent(
      requestUrl: URL,
      request: CreateLifeOpsCalendarEventRequest,
      now = new Date(),
    ): Promise<LifeOpsCalendarEvent> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grantId = normalizeOptionalString(request.grantId);
      const calendarId = normalizeCalendarId(request.calendarId);
      const title = requireNonEmptyString(request.title, "title");
      const description = normalizeOptionalString(request.description) ?? "";
      const location = normalizeOptionalString(request.location) ?? "";
      const attendees = normalizeCalendarAttendees(request.attendees);
      const { startAt, endAt, timeZone } = resolveCalendarEventRange(
        request,
        now,
      );

      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        grantId,
      );
      const createEvent = async () => {
        const created =
          resolveGoogleExecutionTarget(grant) === "cloud"
            ? (
                await this.googleManagedClient.createCalendarEvent({
                  side: grant.side,
                  grantId: grant.id,
                  calendarId,
                  title,
                  description,
                  location,
                  startAt,
                  endAt,
                  timeZone,
                  attendees,
                })
              ).event
            : await createGoogleCalendarEvent({
                accessToken: (
                  await ensureFreshGoogleAccessToken(
                    grant.tokenRef ??
                      fail(409, "Google Calendar token reference is missing."),
                  )
                ).accessToken,
                calendarId,
                title,
                description,
                location,
                startAt,
                endAt,
                timeZone,
                attendees,
              });
        const syncedAt = new Date().toISOString();
        const event: LifeOpsCalendarEvent = {
          id: createCalendarEventId(
            this.agentId(),
            "google",
            grant.side,
            created.calendarId,
            created.externalId,
          ),
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          ...created,
          syncedAt,
          updatedAt: syncedAt,
        };
        await this.repository.upsertCalendarEvent(event, grant.side);
        await this.syncCalendarReminderPlans([event]);
        await this.clearGoogleGrantAuthFailure(grant);
        await this.recordCalendarEventAudit(
          event.id,
          "calendar event created",
          {
            calendarId,
            mode: grant.mode,
            title,
            requestedStartAt: startAt,
            requestedEndAt: endAt,
          },
          {
            externalId: event.externalId,
            htmlLink: event.htmlLink,
          },
        );
        return event;
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, createEvent)
        : this.withGoogleGrantOperation(grant, createEvent);
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
      const calendarId = normalizeCalendarId(request.calendarId);
      const externalEventId = requireNonEmptyString(request.eventId, "eventId");

      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const updateEvent = async () => {
        const normalizedAttendees = request.attendees
          ? normalizeCalendarAttendees(request.attendees)
          : undefined;
        const materializedUpdated =
          resolveGoogleExecutionTarget(grant) === "cloud"
            ? (
                await this.googleManagedClient.updateCalendarEvent({
                  side: grant.side,
                  grantId: grant.id,
                  calendarId,
                  eventId: externalEventId,
                  title: request.title,
                  description: request.description,
                  location: request.location,
                  startAt: request.startAt,
                  endAt: request.endAt,
                  timeZone: request.timeZone,
                  attendees: normalizedAttendees,
                })
              ).event
            : await (async () => {
                const accessToken = (
                  await ensureFreshGoogleAccessToken(
                    grant.tokenRef ??
                      fail(409, "Google Calendar token reference is missing."),
                  )
                ).accessToken;

                // Google's PATCH semantics: if you send `start.dateTime` you must
                // also send `end.dateTime`, otherwise the API rejects the call as
                // "Bad Request" because the event would have inconsistent bounds.
                // When the caller only supplies one bound or omits the timezone,
                // load the current event so we can preserve both the existing
                // timezone and duration instead of guessing.
                const ONE_HOUR_MS = 60 * 60 * 1000;
                const needsExistingEventContext =
                  Boolean(request.startAt || request.endAt) &&
                  (!request.timeZone || !request.startAt || !request.endAt);
                const existingEvent = needsExistingEventContext
                  ? await fetchGoogleCalendarEvent({
                      accessToken,
                      calendarId: calendarId ?? undefined,
                      eventId: externalEventId,
                    })
                  : null;
                const normalizedTimeZone = normalizeCalendarTimeZone(
                  request.timeZone ?? existingEvent?.timezone ?? undefined,
                );
                let normalizedStartAt = normalizeCalendarDateTimeInTimeZone(
                  request.startAt,
                  "startAt",
                  normalizedTimeZone,
                );
                let normalizedEndAt = normalizeCalendarDateTimeInTimeZone(
                  request.endAt,
                  "endAt",
                  normalizedTimeZone,
                );
                const existingDurationMs =
                  existingEvent &&
                  Number.isFinite(Date.parse(existingEvent.startAt)) &&
                  Number.isFinite(Date.parse(existingEvent.endAt))
                    ? Date.parse(existingEvent.endAt) -
                      Date.parse(existingEvent.startAt)
                    : Number.NaN;
                const fallbackDurationMs =
                  Number.isFinite(existingDurationMs) && existingDurationMs > 0
                    ? existingDurationMs
                    : ONE_HOUR_MS;
                if (normalizedStartAt && !normalizedEndAt) {
                  normalizedEndAt = new Date(
                    new Date(normalizedStartAt).getTime() + fallbackDurationMs,
                  ).toISOString();
                } else if (normalizedEndAt && !normalizedStartAt) {
                  normalizedStartAt = new Date(
                    new Date(normalizedEndAt).getTime() - fallbackDurationMs,
                  ).toISOString();
                }

                return updateGoogleCalendarEvent({
                  accessToken,
                  calendarId: calendarId ?? undefined,
                  eventId: externalEventId,
                  title: request.title,
                  description: request.description,
                  location: request.location,
                  startAt: normalizedStartAt,
                  endAt: normalizedEndAt,
                  timeZone: normalizedTimeZone,
                  attendees: normalizedAttendees,
                });
              })();
        const syncedAt = new Date().toISOString();
        const event: LifeOpsCalendarEvent = {
          id: createCalendarEventId(
            this.agentId(),
            "google",
            grant.side,
            materializedUpdated.calendarId,
            materializedUpdated.externalId,
          ),
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          ...materializedUpdated,
          syncedAt,
          updatedAt: syncedAt,
        };
        await this.repository.upsertCalendarEvent(event, grant.side);
        await this.syncCalendarReminderPlans([event]);
        await this.clearGoogleGrantAuthFailure(grant);
        await this.recordCalendarEventAudit(
          event.id,
          "calendar event updated",
          {
            calendarId: calendarId ?? "primary",
            mode: grant.mode,
            patched: Object.fromEntries(
              Object.entries({
                title: request.title,
                description: request.description,
                location: request.location,
                startAt: request.startAt,
                endAt: request.endAt,
                timeZone: request.timeZone,
              }).filter(([, value]) => value !== undefined),
            ),
          },
          {
            externalId: event.externalId,
            htmlLink: event.htmlLink,
          },
          "calendar_event_updated",
        );
        return event;
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, updateEvent)
        : this.withGoogleGrantOperation(grant, updateEvent);
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
      const calendarId = normalizeCalendarId(request.calendarId);
      const externalEventId = requireNonEmptyString(request.eventId, "eventId");

      const grant = await this.requireGoogleCalendarWriteGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const deleteEvent = async () => {
        if (resolveGoogleExecutionTarget(grant) === "cloud") {
          await this.googleManagedClient.deleteCalendarEvent({
            side: grant.side,
            grantId: grant.id,
            calendarId,
            eventId: externalEventId,
          });
        } else {
          const accessToken = (
            await ensureFreshGoogleAccessToken(
              grant.tokenRef ??
                fail(409, "Google Calendar token reference is missing."),
            )
          ).accessToken;
          await deleteGoogleCalendarEvent({
            accessToken,
            calendarId: calendarId ?? undefined,
            eventId: externalEventId,
          });
        }
        // Best-effort: drop the local cached row so subsequent feed reads
        // don't show a phantom event. Ignore failures here — the source of
        // truth (Google) has already accepted the delete.
        try {
          await this.repository.deleteCalendarEventByExternalId(
            this.agentId(),
            "google",
            calendarId ?? "primary",
            externalEventId,
            grant.side,
          );
        } catch {
          // intentionally swallowed: local cache mirror, not authoritative
        }
        await this.clearGoogleGrantAuthFailure(grant);
        await this.recordCalendarEventAudit(
          externalEventId,
          "calendar event deleted",
          {
            calendarId: calendarId ?? "primary",
            mode: grant.mode,
          },
          {
            externalId: externalEventId,
          },
          "calendar_event_deleted",
        );
      };

      return resolveGoogleExecutionTarget(grant) === "cloud"
        ? this.runManagedGoogleOperation(grant, deleteEvent)
        : this.withGoogleGrantOperation(grant, deleteEvent);
    }

    async getNextCalendarEventContext(
      requestUrl: URL,
      request: GetLifeOpsCalendarFeedRequest = {},
      now = new Date(),
    ): Promise<LifeOpsNextCalendarEventContext> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const timeZone = normalizeCalendarTimeZone(request.timeZone);
      const feed = await this.getCalendarFeed(
        requestUrl,
        {
          ...request,
          timeZone,
          ...resolveNextCalendarEventWindow({
            now,
            timeZone,
            requestedTimeMin: request.timeMin,
            requestedTimeMax: request.timeMax,
          }),
        },
        now,
      );
      const nextEvent =
        feed.events.find((event) => Date.parse(event.endAt) > now.getTime()) ??
        null;
      if (!nextEvent) {
        return buildNextCalendarEventContext(null, now);
      }

      let linkedMail: LifeOpsGmailMessageSummary[] = [];
      let linkedMailState: "unavailable" | "cache" | "synced" | "error" =
        "unavailable";
      let linkedMailError: string | null = null;
      const status = await this.getGoogleConnectorStatus(
        requestUrl,
        mode,
        nextEvent.side,
      );
      if (
        status.connected &&
        status.grant &&
        hasGoogleGmailTriageCapability(status.grant)
      ) {
        const cachedMessages = await this.repository.listGmailMessages(
          this.agentId(),
          "google",
          {
            maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
          },
          status.grant.side,
        );
        linkedMail = findLinkedMailForCalendarEvent(nextEvent, cachedMessages);
        linkedMailState = "cache";
        if (linkedMail.length === 0) {
          try {
            const triage = await this.getGmailTriage(
              requestUrl,
              {
                mode,
                side: status.grant.side,
                maxResults: DEFAULT_GMAIL_TRIAGE_MAX_RESULTS,
              },
              now,
            );
            linkedMail = findLinkedMailForCalendarEvent(
              nextEvent,
              triage.messages,
            );
            linkedMailState = "synced";
          } catch (error) {
            if (!(error instanceof LifeOpsServiceError)) {
              throw error;
            }
            this.logLifeOpsWarn(
              "next_calendar_context_linked_mail",
              error.message,
              {
                provider: "google",
                mode: status.mode,
                calendarEventId: nextEvent.id,
              },
            );
            linkedMailState = "error";
            linkedMailError = error.message;
          }
        }
      }

      return buildNextCalendarEventContext(
        nextEvent,
        now,
        linkedMail,
        linkedMailState,
        linkedMailError,
      );
    }
  }

  return LifeOpsCalendarServiceMixin;
}
