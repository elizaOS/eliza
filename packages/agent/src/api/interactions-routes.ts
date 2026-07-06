/**
 * POST /api/interactions/shortcut and /api/interactions/composer — report
 * user UI activity so the agent observes it as first-class interaction context
 * (#8792, #14679).
 *
 * The view-switch half of this contract lives in `views-routes.ts`
 * (`POST /api/views/:id/navigate` → `VIEW_SWITCHED`). This is the keyboard /
 * command-palette half: the client reports a stable `shortcutId` and the route
 * emits `EventType.SHORTCUT_FIRED`, which the proactive-interaction decider
 * consumes (governed by debounce / cooldown / daily-cap / model-judge-silent).
 * The composer half carries only lifecycle metadata (started / paused /
 * abandoned), never draft text, so providers can reason about "user is
 * thinking" without leaking what they have not sent.
 *
 * Emission is fire-and-forget: a dropped event must never break the shortcut the
 * user actually pressed. This route is auth+proxy thin — it records nothing and
 * computes nothing beyond input validation.
 */
import type http from "node:http";
import {
  type AgentRuntime,
  EventType,
  readRequestBodyBuffer,
} from "@elizaos/core";

const MAX_BODY_BYTES = 4 * 1024;

/** Stable shortcut id: kebab-case, bounded length (e.g. "open-command-palette"). */
const SHORTCUT_ID_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
const SURFACE_ID_PATTERN = /^[a-z][a-z0-9_-]{1,64}$/;
const MAX_CONTEXT_CHARS = 120;
const MAX_CONVERSATION_ID_CHARS = 128;
const MAX_DRAFT_LENGTH = 100_000;

const COMPOSER_ACTIVITY_TO_EVENT = {
  typing_started: EventType.USER_TYPING_STARTED,
  typing_paused: EventType.USER_TYPING_PAUSED,
  draft_abandoned: EventType.USER_DRAFT_ABANDONED,
} as const;

type ComposerActivity = keyof typeof COMPOSER_ACTIVITY_TO_EVENT;

export interface InteractionsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  runtime: AgentRuntime | null | undefined;
}

export interface ShortcutInteractionRequest {
  shortcutId: string;
  context?: string;
}

export interface ComposerInteractionRequest {
  activity: ComposerActivity;
  surface: string;
  conversationId?: string;
  draftLength: number;
  idleForMs?: number;
  reason?: "cleared" | "blurred" | "conversation_switched" | "unknown";
  occurredAt: string;
}

/** Parse + validate the shortcut report body; null on anything malformed. */
export function parseShortcutBody(
  raw: string,
): ShortcutInteractionRequest | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted request JSON parses to an explicit invalid body.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  const shortcutId =
    typeof body.shortcutId === "string" ? body.shortcutId.trim() : "";
  if (!SHORTCUT_ID_PATTERN.test(shortcutId)) return null;
  const context =
    typeof body.context === "string" && body.context.trim()
      ? body.context.trim().slice(0, MAX_CONTEXT_CHARS)
      : undefined;
  return { shortcutId, ...(context ? { context } : {}) };
}

function readBoundedString(
  value: unknown,
  maxChars: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxChars) : undefined;
}

function readNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  return integer >= 0 ? integer : null;
}

function readOccurredAt(value: unknown): string | null {
  if (typeof value !== "string") return new Date().toISOString();
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : null;
}

/** Parse + validate a composer lifecycle report; null on anything malformed. */
export function parseComposerBody(
  raw: string,
): ComposerInteractionRequest | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted request JSON parses to an explicit invalid body.
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  const activity =
    typeof body.activity === "string" &&
    body.activity in COMPOSER_ACTIVITY_TO_EVENT
      ? (body.activity as ComposerActivity)
      : null;
  if (!activity) return null;

  const surface = readBoundedString(body.surface, 64);
  if (!surface || !SURFACE_ID_PATTERN.test(surface)) return null;

  const draftLength = readNonNegativeInteger(body.draftLength);
  if (draftLength === null || draftLength > MAX_DRAFT_LENGTH) return null;

  const idleForMs = readNonNegativeInteger(body.idleForMs);
  if (activity === "typing_paused" && idleForMs === null) return null;

  const reason =
    body.reason === "cleared" ||
    body.reason === "blurred" ||
    body.reason === "conversation_switched" ||
    body.reason === "unknown"
      ? body.reason
      : undefined;
  const occurredAt = readOccurredAt(body.occurredAt);
  if (!occurredAt) return null;

  const conversationId = readBoundedString(
    body.conversationId,
    MAX_CONVERSATION_ID_CHARS,
  );
  return {
    activity,
    surface,
    draftLength,
    ...(conversationId ? { conversationId } : {}),
    ...(idleForMs !== null ? { idleForMs } : {}),
    ...(reason ? { reason } : {}),
    occurredAt,
  };
}

export async function handleInteractionsRoutes(
  ctx: InteractionsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, runtime } = ctx;
  if (
    pathname !== "/api/interactions/shortcut" &&
    pathname !== "/api/interactions/composer"
  ) {
    return false;
  }
  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }

  const buffer = await readRequestBodyBuffer(req, {
    maxBytes: MAX_BODY_BYTES,
    returnNullOnTooLarge: true,
  });
  if (pathname === "/api/interactions/composer") {
    const request = parseComposerBody(buffer?.toString("utf8") ?? "");
    if (!request) {
      error(res, "Invalid composer interaction body", 400);
      return true;
    }

    if (runtime) {
      const eventType = COMPOSER_ACTIVITY_TO_EVENT[request.activity];
      void runtime
        .emitEvent(eventType, {
          runtime,
          source: "composer-interaction",
          activity: request.activity,
          surface: request.surface,
          ...(request.conversationId
            ? { conversationId: request.conversationId }
            : {}),
          draftLength: request.draftLength,
          ...(request.idleForMs !== undefined
            ? { idleForMs: request.idleForMs }
            : {}),
          ...(request.reason ? { reason: request.reason } : {}),
          occurredAt: request.occurredAt,
          initiatedBy: "user",
        })
        .catch((err) => {
          // error-policy:J7 telemetry emission must not break the interaction
          // route, but a broken event bus must reach RECENT_ERRORS.
          runtime.reportError("InteractionsRoutes.composerActivity", err, {
            activity: request.activity,
            surface: request.surface,
          });
        });
    }

    json(res, { ok: true, activity: request.activity });
    return true;
  }

  const request = parseShortcutBody(buffer?.toString("utf8") ?? "");
  if (!request) {
    error(res, "Invalid shortcut interaction body", 400);
    return true;
  }

  // Emit the first-class SHORTCUT_FIRED interaction event (#8792). Fire-and-forget
  // so the proactive decider can react without ever blocking the response.
  if (runtime) {
    void runtime
      .emitEvent(EventType.SHORTCUT_FIRED, {
        runtime,
        source: "shortcut-interaction",
        shortcutId: request.shortcutId,
        ...(request.context ? { context: request.context } : {}),
        initiatedBy: "user",
      })
      .catch((err) => {
        // error-policy:J7 telemetry emission must not break the interaction
        // route, but a broken event bus must reach RECENT_ERRORS.
        runtime.reportError("InteractionsRoutes.shortcutFired", err, {
          shortcutId: request.shortcutId,
        });
      });
  }

  json(res, { ok: true, shortcutId: request.shortcutId });
  return true;
}
