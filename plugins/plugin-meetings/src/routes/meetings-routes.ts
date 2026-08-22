/**
 * Meeting HTTP routes — `/api/meetings*`, served as rawPath plugin routes
 * (registered on `runtime.routes`, dispatched by both the upstream agent
 * server and app-core), following the exact pattern of the transcripts routes
 * in plugin-local-inference. Private routes: the host dispatcher answers 401
 * for unauthenticated callers.
 *
 * Thin proxy layer over MeetingService — no business logic here.
 */

import type {
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
  UUID,
} from "@elizaos/core";
import type {
  MeetingJoinRequest,
  MeetingPlatform,
  MeetingSession,
} from "@elizaos/shared";
import { parseMeetingUrl } from "@elizaos/shared";
import { ZoomCloudImportError } from "../platforms/zoom/cloud-import.js";
import { MeetingJoinError, type MeetingService } from "../service.js";
import { selectSessionForViewer } from "../session-disclosure.js";

function service(ctx: RouteHandlerContext): MeetingService | null {
  return ctx.runtime.getService<MeetingService>("meetings");
}

const unavailable: RouteHandlerResult = {
  status: 503,
  body: { error: "meetings service is not running" },
};

/** Per-viewer session DTO selection lives in the use-case module (#14781). */
function sessionForViewer(
  ctx: RouteHandlerContext,
  session: MeetingSession,
): Promise<MeetingSession> {
  return selectSessionForViewer(ctx.runtime, ctx.accessContext, session);
}

/** The body POST /api/meetings accepts. */
export interface CreateMeetingRequest {
  meetingUrl: string;
  /** Optional; derived from the URL when absent, validated when present. */
  platform?: MeetingPlatform;
  botName?: string;
  language?: string;
  retainAudio?: boolean;
  maxDurationMs?: number;
  calendarEventId?: string;
}

const joinErrorStatus: Record<MeetingJoinError["code"], number> = {
  invalid_url: 400,
  unsupported_platform: 422,
  unsupported_host: 422,
  policy_blocked: 403,
  already_joined: 409,
  service_stopping: 503,
  invalid_duration_cap: 400,
  insufficient_credits: 402,
};

const createRoute: Route = {
  type: "POST",
  path: "/api/meetings",
  rawPath: true,
  routeHandler: async (ctx): Promise<RouteHandlerResult> => {
    const svc = service(ctx);
    if (!svc) return unavailable;
    const body = ctx.body as CreateMeetingRequest | undefined;
    if (
      !body ||
      typeof body.meetingUrl !== "string" ||
      !body.meetingUrl.trim()
    ) {
      return { status: 400, body: { error: "meetingUrl is required" } };
    }
    const parsed = parseMeetingUrl(body.meetingUrl);
    if (!parsed) {
      return {
        status: 400,
        body: { error: "meetingUrl is not a recognizable meeting link" },
      };
    }
    if (body.platform && body.platform !== parsed.platform) {
      return {
        status: 400,
        body: {
          error: `platform mismatch: URL is a ${parsed.platform} link, request says ${body.platform}`,
        },
      };
    }
    const request: MeetingJoinRequest = {
      platform: parsed.platform,
      meetingUrl: body.meetingUrl,
      botName: body.botName,
      language: body.language,
      retainAudio: body.retainAudio,
      maxDurationMs: body.maxDurationMs,
      calendarEventId: body.calendarEventId,
    };
    try {
      const session = await svc.requestJoin(request);
      return { status: 201, body: { session } };
    } catch (err) {
      // error-policy:J1 boundary translation — a typed MeetingJoinError maps to
      // its declared status/code; any other failure rethrows to the outer
      // server handler as a 5xx rather than being masked as a join result.
      if (err instanceof MeetingJoinError) {
        return {
          status: joinErrorStatus[err.code],
          body: { error: err.message, code: err.code },
        };
      }
      throw err;
    }
  },
};

const listRoute: Route = {
  type: "GET",
  path: "/api/meetings",
  rawPath: true,
  routeHandler: async (ctx): Promise<RouteHandlerResult> => {
    const svc = service(ctx);
    if (!svc) return unavailable;
    const activeParam = ctx.query.active;
    const active =
      activeParam === "1" || activeParam === "true" ? true : undefined;
    const sessions = await Promise.all(
      svc
        .listSessions({ active })
        .map((session) => sessionForViewer(ctx, session)),
    );
    return { status: 200, body: { sessions } };
  },
};

/** Private authenticated body accepted by the Zoom cloud-import boundary. */
export interface ImportZoomMeetingRequest {
  meetingId: string;
  /** Short-lived OAuth token; never logged or persisted. */
  accessToken?: string;
  retainRecordings?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const importZoomRoute: Route = {
  type: "POST",
  path: "/api/meetings/import/zoom",
  rawPath: true,
  routeHandler: async (ctx): Promise<RouteHandlerResult> => {
    const svc = service(ctx);
    if (!svc) return unavailable;
    const body = ctx.body as ImportZoomMeetingRequest | undefined;
    if (!body || typeof body.meetingId !== "string" || !body.meetingId.trim()) {
      return { status: 400, body: { error: "meetingId is required" } };
    }
    if (
      body.accessToken !== undefined &&
      (typeof body.accessToken !== "string" || !body.accessToken.trim())
    ) {
      return {
        status: 400,
        body: { error: "accessToken must be a non-empty string" },
      };
    }
    if (
      body.retainRecordings !== undefined &&
      typeof body.retainRecordings !== "boolean"
    ) {
      return {
        status: 400,
        body: { error: "retainRecordings must be boolean" },
      };
    }
    try {
      const result = await svc.importZoomMeeting(body);
      return { status: 201, body: result };
    } catch (error) {
      // error-policy:J1 Typed provider/import failures are translated at the
      // private HTTP boundary; unknown storage/runtime failures remain 5xx.
      if (error instanceof ZoomCloudImportError) {
        return {
          status: error.status && error.status >= 400 ? error.status : 502,
          body: {
            error: error.message,
            code: error.code,
            requestId: error.requestId,
          },
        };
      }
      throw error;
    }
  },
};

const getRoute: Route = {
  type: "GET",
  path: "/api/meetings/:id",
  rawPath: true,
  routeHandler: async (ctx): Promise<RouteHandlerResult> => {
    const svc = service(ctx);
    if (!svc) return unavailable;
    const session = svc.getSession(ctx.params.id as UUID);
    if (!session) return { status: 404, body: { error: "not found" } };
    return {
      status: 200,
      body: { session: await sessionForViewer(ctx, session) },
    };
  },
};

const deleteRoute: Route = {
  type: "DELETE",
  path: "/api/meetings/:id",
  rawPath: true,
  routeHandler: async (ctx): Promise<RouteHandlerResult> => {
    const svc = service(ctx);
    if (!svc) return unavailable;
    const session = svc.getSession(ctx.params.id as UUID);
    if (!session) return { status: 404, body: { error: "not found" } };
    const stopped = svc.stopSession(ctx.params.id as UUID);
    return {
      status: 200,
      body: {
        ok: true,
        stopped,
        session: svc.getSession(ctx.params.id as UUID),
      },
    };
  },
};

export const meetingsRoutes: Route[] = [
  createRoute,
  listRoute,
  importZoomRoute,
  getRoute,
  deleteRoute,
];
