/**
 * Centrally authenticated REST boundary for the Simple Views workbench. Route
 * handlers stay thin: they validate transport shape, invoke the domain service,
 * and translate typed failures into explicit HTTP states without fabricating an
 * empty success response when persistence is unavailable.
 */

import {
  ElizaError,
  isElizaError,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
  toElizaError,
} from "@elizaos/core";
import { interact } from "./interact.js";
import { getSimpleViewsService } from "./service.js";
import { isRecord } from "./validation.js";

interface SuccessBody {
  success: true;
  data: unknown;
}

function requestError(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: "SIMPLE_VIEWS_VALIDATION_FAILED",
    context: { field },
    severity: "ephemeral",
  });
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw requestError("Request body must be a JSON object.", "body");
  }
  return body;
}

function assertOnlyBodyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw requestError(
      `Request body contains unsupported field "${unknownKey}".`,
      unknownKey,
    );
  }
}

function routeId(context: RouteHandlerContext): string {
  const id = context.params.id;
  if (!id) throw requestError("Route id is required.", "id");
  return id;
}

function errorStatus(error: ElizaError): number {
  if (error.code === "SIMPLE_VIEWS_VALIDATION_FAILED") return 400;
  if (error.code === "SIMPLE_VIEWS_UNKNOWN_CAPABILITY") return 400;
  if (error.code === "SIMPLE_VIEWS_AMBIGUOUS_NOTE") return 409;
  if (error.code === "SIMPLE_VIEWS_NOT_FOUND") return 404;
  if (
    error.code === "SIMPLE_VIEWS_SERVICE_UNAVAILABLE" ||
    error.code === "SIMPLE_VIEWS_STORE_UNAVAILABLE"
  ) {
    return 503;
  }
  return 500;
}

async function routeBoundary(
  context: RouteHandlerContext,
  successStatus: number,
  operation: () => Promise<unknown> | unknown,
): Promise<RouteHandlerResult> {
  try {
    const data = await operation();
    const body: SuccessBody = { success: true, data };
    return { status: successStatus, body };
  } catch (error) {
    // error-policy:J1 boundary translation — this is the authenticated HTTP
    // boundary; typed domain failures become non-2xx JSON and systemic failures
    // are also reported into the runtime diagnostics channel.
    const normalized = isElizaError(error)
      ? error
      : toElizaError(error, "SIMPLE_VIEWS_ROUTE_FAILED");
    const status = errorStatus(normalized);
    if (status >= 500) {
      context.runtime.reportError("SimpleViewsRoutes", normalized, {
        method: context.method,
        path: context.path,
      });
    }
    return {
      status,
      body: {
        success: false,
        error: {
          code: normalized.code,
          message: normalized.message,
        },
      },
    };
  }
}

const simpleViewsRouteDefinitions: Route[] = [
  {
    type: "GET",
    name: "simple-views-state",
    path: "/api/simple-views/state",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).snapshot(),
      ),
  },
  {
    type: "GET",
    name: "simple-views-list-notes",
    path: "/api/simple-views/notes",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).listNotes(),
      ),
  },
  {
    type: "POST",
    name: "simple-views-create-note",
    path: "/api/simple-views/notes",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 201, () =>
        getSimpleViewsService(context.runtime).createNote(context.body),
      ),
  },
  {
    type: "DELETE",
    name: "simple-views-clear-notes",
    path: "/api/simple-views/notes",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, async () => ({
        cleared: await getSimpleViewsService(context.runtime).clearNotes(),
      })),
  },
  {
    type: "GET",
    name: "simple-views-get-note",
    path: "/api/simple-views/notes/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).getNote(routeId(context)),
      ),
  },
  {
    type: "PATCH",
    name: "simple-views-update-note",
    path: "/api/simple-views/notes/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).updateNote(
          routeId(context),
          context.body,
        ),
      ),
  },
  {
    type: "DELETE",
    name: "simple-views-delete-note",
    path: "/api/simple-views/notes/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).deleteNote(routeId(context)),
      ),
  },
  {
    type: "GET",
    name: "simple-views-list-calendar-events",
    path: "/api/simple-views/calendar/events",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () => {
        const date = context.query.date;
        if (Array.isArray(date)) {
          throw requestError("date query must occur once.", "date");
        }
        return getSimpleViewsService(context.runtime).listCalendarEvents(date);
      }),
  },
  {
    type: "POST",
    name: "simple-views-create-calendar-event",
    path: "/api/simple-views/calendar/events",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 201, () =>
        getSimpleViewsService(context.runtime).createCalendarEvent(
          context.body,
        ),
      ),
  },
  {
    type: "GET",
    name: "simple-views-get-calendar-event",
    path: "/api/simple-views/calendar/events/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).getCalendarEvent(
          routeId(context),
        ),
      ),
  },
  {
    type: "PATCH",
    name: "simple-views-update-calendar-event",
    path: "/api/simple-views/calendar/events/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).updateCalendarEvent(
          routeId(context),
          context.body,
        ),
      ),
  },
  {
    type: "DELETE",
    name: "simple-views-delete-calendar-event",
    path: "/api/simple-views/calendar/events/:id",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () =>
        getSimpleViewsService(context.runtime).deleteCalendarEvent(
          routeId(context),
        ),
      ),
  },
  {
    type: "GET",
    name: "simple-views-get-selected-date",
    path: "/api/simple-views/calendar/selected-date",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () => ({
        date: getSimpleViewsService(context.runtime).selectedDate(),
      })),
  },
  {
    type: "PUT",
    name: "simple-views-select-date",
    path: "/api/simple-views/calendar/selected-date",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, () => {
        const body = bodyRecord(context.body);
        assertOnlyBodyKeys(body, ["date"]);
        return getSimpleViewsService(context.runtime)
          .selectDate(body.date)
          .then((date) => ({ date }));
      }),
  },
  {
    type: "POST",
    name: "simple-views-interact",
    path: "/api/simple-views/interact",
    rawPath: true,
    routeHandler: (context) =>
      routeBoundary(context, 200, async () => {
        const body = bodyRecord(context.body);
        assertOnlyBodyKeys(body, ["capability", "params"]);
        if (
          typeof body.capability !== "string" ||
          body.capability.trim().length === 0
        ) {
          throw requestError("capability is required.", "capability");
        }
        if (body.params !== undefined && !isRecord(body.params)) {
          throw requestError("params must be a JSON object.", "params");
        }
        const result = await interact(
          body.capability.trim(),
          body.params,
          getSimpleViewsService(context.runtime),
        );
        if (!result.success && result.error) {
          throw new ElizaError(result.error.message, {
            code: result.error.code,
            severity: "ephemeral",
          });
        }
        return result;
      }),
  },
];

const SIMPLE_VIEWS_ROUTE_MODES = ["local", "local-only"] as const;

export const simpleViewsRoutes: Route[] = simpleViewsRouteDefinitions.map(
  (route) => ({
    ...route,
    modes: SIMPLE_VIEWS_ROUTE_MODES,
    modeReason:
      "developer workbench state is available only from a local agent runtime",
  }),
);
