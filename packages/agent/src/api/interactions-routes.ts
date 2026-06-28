/**
 * POST /api/interactions/shortcut — report a user-fired UI/keyboard shortcut so
 * the agent observes it as a first-class interaction (#8792).
 *
 * The view-switch half of this contract lives in `views-routes.ts`
 * (`POST /api/views/:id/navigate` → `VIEW_SWITCHED`). This is the keyboard /
 * command-palette half: the client reports a stable `shortcutId` and the route
 * emits `EventType.SHORTCUT_FIRED`, which the proactive-interaction decider
 * consumes (governed by debounce / cooldown / daily-cap / model-judge-silent).
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
const MAX_CONTEXT_CHARS = 120;

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

/** Parse + validate the shortcut report body; null on anything malformed. */
export function parseShortcutBody(
  raw: string,
): ShortcutInteractionRequest | null {
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
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

export async function handleInteractionsRoutes(
  ctx: InteractionsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, runtime } = ctx;
  if (pathname !== "/api/interactions/shortcut") return false;
  if (method !== "POST") {
    error(res, "Method not allowed", 405);
    return true;
  }

  const buffer = await readRequestBodyBuffer(req, {
    maxBytes: MAX_BODY_BYTES,
    returnNullOnTooLarge: true,
  });
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
        runtime.logger?.debug?.(
          { src: "InteractionsRoutes", err },
          "[InteractionsRoutes] SHORTCUT_FIRED emit failed",
        );
      });
  }

  json(res, { ok: true, shortcutId: request.shortcutId });
  return true;
}
