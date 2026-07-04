/**
 * Runtime adapter binding the calendar HTTP routes to the agent runtime:
 * resolves `CalendarService` at the request boundary, applies rate limiting, and
 * delegates to the path→service dispatcher (`handleCalendarRoutes`), translating
 * service-resolution and domain failures into structured error responses.
 */
import type http from "node:http";
import {
  ElizaError,
  type IAgentRuntime,
  type LegacyRouteHandler,
  logger,
  type Route,
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { CalendarServiceError } from "../internal/errors.js";
import {
  type CalendarRouteService,
  handleCalendarRoutes,
} from "./calendar-routes.js";

type HttpRouteType = Exclude<Route["type"], "STATIC">;

interface CalendarRouteSpec {
  type: HttpRouteType;
  path: string;
}

type CalendarRateLimitKey =
  | "google_api_read"
  | "google_api_write"
  | "calendar_create"
  | "calendar_update"
  | "calendar_delete";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const CALENDAR_ROUTE_SPECS: readonly CalendarRouteSpec[] = [
  { type: "GET", path: "/api/lifeops/calendar/feed" },
  { type: "GET", path: "/api/lifeops/calendar/meeting-auto-join" },
  { type: "PUT", path: "/api/lifeops/calendar/meeting-auto-join" },
  { type: "GET", path: "/api/lifeops/calendar/calendars" },
  { type: "PUT", path: "/api/lifeops/calendar/calendars/:id/include" },
  { type: "GET", path: "/api/lifeops/calendar/next-context" },
  { type: "POST", path: "/api/lifeops/calendar/events" },
  { type: "PATCH", path: "/api/lifeops/calendar/events/:eventId" },
  { type: "DELETE", path: "/api/lifeops/calendar/events/:eventId" },
];

const CALENDAR_SERVICE_TYPE = "calendar";

const CONNECTOR_MODES = [
  "local",
  "remote",
  "cloud_managed",
] as const satisfies readonly LifeOpsConnectorMode[];
const CONNECTOR_SIDES = [
  "owner",
  "agent",
] as const satisfies readonly LifeOpsConnectorSide[];

const CALENDAR_RATE_LIMITS: Record<CalendarRateLimitKey, RateLimitConfig> = {
  google_api_read: { maxRequests: 120, windowMs: 60_000 },
  google_api_write: { maxRequests: 30, windowMs: 60_000 },
  calendar_create: { maxRequests: 20, windowMs: 60_000 },
  calendar_update: { maxRequests: 30, windowMs: 60_000 },
  calendar_delete: { maxRequests: 20, windowMs: 60_000 },
};

const rateLimitBuckets = new Map<string, number[]>();

function requestBaseUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const protocol = req.headers["x-forwarded-proto"];
  const normalizedProtocol = Array.isArray(protocol)
    ? protocol[0]
    : (protocol ?? "http");
  return `${normalizedProtocol}://${Array.isArray(host) ? host[0] : host}`;
}

function parseRequestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", requestBaseUrl(req));
}

function isCalendarRouteService(
  service: unknown,
): service is CalendarRouteService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as CalendarRouteService).getCalendarFeed === "function" &&
    typeof (service as CalendarRouteService).listCalendars === "function" &&
    typeof (service as CalendarRouteService).setCalendarIncluded ===
      "function" &&
    typeof (service as CalendarRouteService).getNextCalendarEventContext ===
      "function" &&
    typeof (service as CalendarRouteService).createCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).updateCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).deleteCalendarEvent === "function"
  );
}

async function resolveCalendarService(
  runtime: IAgentRuntime | null,
): Promise<CalendarRouteService | null> {
  if (!runtime) return null;

  const existing = runtime.getService(CALENDAR_SERVICE_TYPE);
  if (isCalendarRouteService(existing)) {
    return existing;
  }

  try {
    const loaded = await runtime.getServiceLoadPromise(CALENDAR_SERVICE_TYPE);
    return isCalendarRouteService(loaded) ? loaded : null;
  } catch (error) {
    runtime.reportError?.("CalendarRoutes.serviceLoad", error, {
      serviceType: CALENDAR_SERVICE_TYPE,
    });
    throw new ElizaError("Calendar service failed to load.", {
      code: "CALENDAR_SERVICE_LOAD_FAILED",
      cause: error,
    });
  }
}

function rateLimitRequest(args: {
  runtime: IAgentRuntime | null;
  res: http.ServerResponse;
  key: CalendarRateLimitKey;
}): boolean {
  const { runtime, res, key } = args;
  const config = CALENDAR_RATE_LIMITS[key];
  const bucketKey = `${String(runtime?.agentId ?? "unknown")}:${key}`;
  const now = Date.now();
  const cutoff = now - config.windowMs;
  const timestamps = (rateLimitBuckets.get(bucketKey) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );

  if (timestamps.length >= config.maxRequests) {
    const retryAfterMs = Math.max(
      (timestamps[0] ?? now) + config.windowMs - now,
      0,
    );
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.ceil(retryAfterMs / 1_000)),
    });
    res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs }));
    return true;
  }

  timestamps.push(now);
  rateLimitBuckets.set(bucketKey, timestamps);
  return false;
}

function parseConnectorMode(
  value: string | null,
): LifeOpsConnectorMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!CONNECTOR_MODES.includes(normalized as LifeOpsConnectorMode)) {
    throw new CalendarServiceError(
      400,
      `mode must be one of: ${CONNECTOR_MODES.join(", ")}`,
    );
  }
  return normalized as LifeOpsConnectorMode;
}

function parseConnectorSide(
  value: string | null,
): LifeOpsConnectorSide | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!CONNECTOR_SIDES.includes(normalized as LifeOpsConnectorSide)) {
    throw new CalendarServiceError(
      400,
      `side must be one of: ${CONNECTOR_SIDES.join(", ")}`,
    );
  }
  return normalized as LifeOpsConnectorSide;
}

function parseBoolean(
  value: string | null,
  field: string,
): boolean | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  throw new CalendarServiceError(400, `${field} must be a boolean`);
}

async function readCalendarJsonBody<T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  const parsedBody = (req as http.IncomingMessage & { body?: unknown }).body;
  if (parsedBody !== undefined) {
    if (
      parsedBody !== null &&
      typeof parsedBody === "object" &&
      !Array.isArray(parsedBody)
    ) {
      return parsedBody as T;
    }
    sendJsonError(res, "Request body must be a JSON object", 400);
    return null;
  }

  const rawBody = (req as http.IncomingMessage & { rawBody?: unknown }).rawBody;
  if (typeof rawBody === "string") {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as T;
      }
    } catch {
      sendJsonError(res, "Invalid JSON in request body", 400);
      return null;
    }
    sendJsonError(res, "Request body must be a JSON object", 400);
    return null;
  }

  return readJsonBody<T>(req, res);
}

async function runCalendarRoute(
  runtime: IAgentRuntime | null,
  res: http.ServerResponse,
  operation: string,
  fn: (service: CalendarRouteService) => Promise<void>,
): Promise<boolean> {
  const service = await resolveCalendarService(runtime);
  if (!service) {
    logger.warn(
      { boundary: "calendar", operation, statusCode: 503 },
      "[calendar] Route rejected because CalendarService is unavailable",
    );
    sendJsonError(res, "Calendar service is not available.", 503);
    return true;
  }

  try {
    await fn(service);
    return true;
  } catch (error) {
    if (error instanceof CalendarServiceError) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        { boundary: "calendar", operation, statusCode: error.status },
        `[calendar] Route failed: ${error.message}`,
      );
      sendJsonError(res, error.message, error.status);
      return true;
    }
    logger.error(
      { boundary: "calendar", operation },
      `[calendar] Route crashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

export function calendarRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as IAgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = parseRequestUrl(httpReq);
    const operation = `${method} ${url.pathname}`;

    const handled = await handleCalendarRoutes({
      method,
      pathname: url.pathname,
      url,
      runRoute: (fn) => runCalendarRoute(agentRuntime, httpRes, operation, fn),
      rateLimit: (key) =>
        rateLimitRequest({
          runtime: agentRuntime,
          res: httpRes,
          key: key as CalendarRateLimitKey,
        }),
      json: (data, status) => sendJson(httpRes, data, status),
      readJsonBody: <T extends object>() =>
        readCalendarJsonBody<T>(httpReq, httpRes),
      decodePathComponent: (raw, label) => {
        try {
          return decodeURIComponent(raw);
        } catch {
          sendJsonError(
            httpRes,
            `Invalid ${label}: malformed URL encoding`,
            400,
          );
          return null;
        }
      },
      parseConnectorMode,
      parseConnectorSide,
      parseBoolean,
      serviceError: (status, message) =>
        new CalendarServiceError(status, message),
    });

    if (!handled && !httpRes.headersSent) {
      sendJsonError(httpRes, "Not found", 404);
    }
  };
}

const handler = calendarRouteHandler();

export const calendarHttpRoutes: Route[] = CALENDAR_ROUTE_SPECS.map(
  (spec): Route => ({
    type: spec.type,
    path: spec.path,
    rawPath: true,
    handler,
  }),
);
