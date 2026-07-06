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
  AccessContext,
  Memory,
  Route,
  RouteHandlerContext,
  RouteHandlerResult,
  UUID,
} from "@elizaos/core";
import { actorFromAccessContext, canReadScope } from "@elizaos/core";
import type {
  MeetingJoinRequest,
  MeetingPlatform,
  MeetingSession,
} from "@elizaos/shared";
import { parseMeetingUrl } from "@elizaos/shared";
import type { TranscriptScope } from "@elizaos/shared/transcripts";
import { normalizeTranscriptScope } from "@elizaos/shared/transcripts";
import { MeetingJoinError, type MeetingService } from "../service.js";

function service(ctx: RouteHandlerContext): MeetingService | null {
  return ctx.runtime.getService<MeetingService>("meetings");
}

const unavailable: RouteHandlerResult = {
  status: 503,
  body: { error: "meetings service is not running" },
};

function transcriptScopeFromRow(row: Memory): TranscriptScope {
  const raw = (row.content as { transcript?: unknown } | undefined)?.transcript;
  if (typeof raw !== "string") return "owner-private";
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizeTranscriptScope(
      parsed && typeof parsed === "object"
        ? (parsed as { scope?: unknown }).scope
        : undefined,
    );
  } catch {
    // error-policy:J3 untrusted stored JSON — an unparseable transcript row
    // fails CLOSED to owner-private so corruption can never widen visibility.
    return "owner-private";
  }
}

function canAccessTranscriptRow(
  row: Memory,
  accessContext: AccessContext,
  agentId: UUID,
): boolean {
  if (accessContext.requesterEntityId === agentId) return true;
  const metadata = row.metadata as Record<string, unknown> | undefined;
  const scopedTo = metadata?.scopedToEntityId;
  const scopedEntityId =
    typeof scopedTo === "string" ? (scopedTo as UUID) : row.entityId;
  const actor = actorFromAccessContext(accessContext, agentId);
  if (actor.role === "OWNER") return true;
  return canReadScope(transcriptScopeFromRow(row), scopedEntityId, actor);
}

async function redactSessionTranscriptDisclosure(
  ctx: RouteHandlerContext,
  session: MeetingSession,
): Promise<MeetingSession> {
  const accessContext = ctx.accessContext;
  if (!accessContext || !session.transcriptId) return session;
  const row = await ctx.runtime.getMemoryById(session.transcriptId as UUID);
  if (
    row &&
    canAccessTranscriptRow(row, accessContext, ctx.runtime.agentId as UUID)
  ) {
    return session;
  }
  const { transcriptId: _transcriptId, ...redacted } = session;
  return redacted;
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
  already_joined: 409,
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
        .map((session) => redactSessionTranscriptDisclosure(ctx, session)),
    );
    return { status: 200, body: { sessions } };
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
      body: { session: await redactSessionTranscriptDisclosure(ctx, session) },
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
  getRoute,
  deleteRoute,
];
