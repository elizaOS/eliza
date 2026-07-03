/**
 * Calendar HTTP route logic for `/api/lifeops/calendar/*`.
 *
 * The path → CalendarService mapping lives here so the calendar surface is
 * owned by the calendar plugin. The generic HTTP plumbing it needs — service
 * resolution + telemetry + schema bootstrap (`runRoute`), rate limiting, body
 * parsing, JSON writing — is host infrastructure and is injected via
 * {@link CalendarRouteDeps} so this module never depends on the host plugin
 * (dependency direction stays `host -> plugin-calendar`). Paths are unchanged
 * contract surface the client + task-coordinator depend on.
 */

import type {
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  ListLifeOpsCalendarsRequest,
  SetLifeOpsCalendarIncludedRequest,
} from "@elizaos/shared";

/** The calendar method surface the route handlers invoke. */
export interface CalendarRouteService {
  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
  ): Promise<unknown>;
  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<unknown>;
  setCalendarIncluded(
    requestUrl: URL,
    request: {
      calendarId: string;
      includeInFeed: boolean;
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
    },
  ): Promise<unknown>;
  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
  ): Promise<unknown>;
  createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
  ): Promise<unknown>;
  updateCalendarEvent(
    requestUrl: URL,
    request: Record<string, unknown> & { eventId: string },
  ): Promise<unknown>;
  deleteCalendarEvent(
    requestUrl: URL,
    request: { eventId: string } & Record<string, unknown>,
  ): Promise<void>;
}

/** Host-provided HTTP plumbing. */
export interface CalendarRouteDeps {
  method: string;
  pathname: string;
  url: URL;
  /** Resolve the calendar service (with telemetry + schema bootstrap) and run `fn`. Returns `true` once handled. */
  runRoute: (
    fn: (service: CalendarRouteService) => Promise<void>,
  ) => Promise<boolean>;
  /** Returns `true` when the request is rate-limited (caller should stop). */
  rateLimit: (key: string) => boolean;
  json: (data: unknown, status?: number) => void;
  readJsonBody: <T extends object>() => Promise<T | null>;
  /** Decode a matched path component, writing a 400 + returning null on failure. */
  decodePathComponent: (raw: string, label: string) => string | null;
  parseConnectorMode: (
    value: string | null,
  ) => LifeOpsConnectorMode | undefined;
  parseConnectorSide: (
    value: string | null,
  ) => LifeOpsConnectorSide | undefined;
  parseBoolean: (value: string | null, field: string) => boolean | undefined;
  /** Build a host service error carrying an HTTP status (e.g. LifeOpsServiceError). */
  serviceError: (status: number, message: string) => Error;
}

/**
 * Handle a calendar route. Resolves to `true` when the request matched a
 * calendar path (and was served/short-circuited), or `false` when no calendar
 * route matched and the host should continue its own dispatch.
 */
export async function handleCalendarRoutes(
  deps: CalendarRouteDeps,
): Promise<boolean> {
  const { method, pathname, url } = deps;
  const q = url.searchParams;

  if (method === "GET" && pathname === "/api/lifeops/calendar/feed") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        calendarId: q.get("calendarId") ?? undefined,
        includeHiddenCalendars: deps.parseBoolean(
          q.get("includeHiddenCalendars"),
          "includeHiddenCalendars",
        ),
        timeMin: q.get("timeMin") ?? undefined,
        timeMax: q.get("timeMax") ?? undefined,
        timeZone: q.get("timeZone") ?? undefined,
        forceSync: deps.parseBoolean(q.get("forceSync"), "forceSync"),
        grantId: q.get("grantId") ?? undefined,
      };
      deps.json(await service.getCalendarFeed(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/calendars") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: ListLifeOpsCalendarsRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        grantId: q.get("grantId") ?? undefined,
      };
      const calendars = await service.listCalendars(url, request);
      deps.json({ calendars });
    });
  }

  const setIncludedMatch =
    method === "PUT"
      ? pathname.match(
          /^\/api\/lifeops\/calendar\/calendars\/([^/]+)\/include$/,
        )
      : null;
  if (setIncludedMatch) {
    if (deps.rateLimit("google_api_write")) return true;
    const calendarId = deps.decodePathComponent(
      setIncludedMatch[1],
      "calendarId",
    );
    if (!calendarId) return true;
    const body = await deps.readJsonBody<SetLifeOpsCalendarIncludedRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      if (body.calendarId && body.calendarId !== calendarId) {
        throw deps.serviceError(
          400,
          "calendarId must match between path and request body",
        );
      }
      const calendar = await service.setCalendarIncluded(url, {
        calendarId,
        includeInFeed: body.includeInFeed,
        mode: body.mode,
        side: body.side,
        grantId: body.grantId,
      });
      deps.json({ calendar });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/next-context") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        calendarId: q.get("calendarId") ?? undefined,
        timeMin: q.get("timeMin") ?? undefined,
        timeMax: q.get("timeMax") ?? undefined,
        timeZone: q.get("timeZone") ?? undefined,
      };
      deps.json(await service.getNextCalendarEventContext(url, request));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/events") {
    if (deps.rateLimit("calendar_create")) return true;
    const body = await deps.readJsonBody<CreateLifeOpsCalendarEventRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      deps.json({ event: await service.createCalendarEvent(url, body) }, 201);
    });
  }

  const eventMatch = pathname.match(
    /^\/api\/lifeops\/calendar\/events\/([^/]+)$/,
  );
  if (eventMatch) {
    const eventId = deps.decodePathComponent(eventMatch[1], "event id");
    if (!eventId) return true;
    if (method === "PATCH") {
      if (deps.rateLimit("calendar_update")) return true;
      const body = await deps.readJsonBody<LifeOpsCalendarEventUpdate>();
      if (!body) return true;
      return deps.runRoute(async (service) => {
        const event = await service.updateCalendarEvent(url, {
          eventId,
          mode: body.mode ?? deps.parseConnectorMode(q.get("mode")),
          side: body.side ?? deps.parseConnectorSide(q.get("side")),
          grantId: body.grantId ?? q.get("grantId") ?? undefined,
          calendarId: body.calendarId ?? q.get("calendarId") ?? undefined,
          title: body.title,
          description: body.notes,
          startAt: body.startAt,
          endAt: body.endAt,
          timeZone: body.timeZone,
          location: body.location,
          attendees: body.attendees,
          recurrence: body.recurrence,
          recurrenceScope: body.recurrenceScope,
        });
        deps.json({ event });
      });
    }
    if (method === "DELETE") {
      if (deps.rateLimit("calendar_delete")) return true;
      return deps.runRoute(async (service) => {
        await service.deleteCalendarEvent(url, {
          eventId,
          side: deps.parseConnectorSide(q.get("side")),
          grantId: q.get("grantId") ?? undefined,
          calendarId: q.get("calendarId") ?? undefined,
          // Validated in the service; invalid values 400 instead of silently
          // degrading a series delete to a single-occurrence delete.
          recurrenceScope: (q.get("recurrenceScope") ?? undefined) as
            | LifeOpsCalendarRecurrenceScope
            | undefined,
        });
        deps.json({ deleted: true });
      });
    }
  }

  return false;
}
