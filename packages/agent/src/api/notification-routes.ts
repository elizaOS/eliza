/**
 * Notification routes.
 *
 * HTTP surface over the runtime `NotificationService` so clients can hydrate
 * the notification center on load (WS only carries live events), mark items
 * read, and — for triggers that don't run inside the agent process (external
 * automations, tests) — create a notification.
 *
 * Routes:
 *
 *   GET    /api/notifications?unreadOnly=&category=&limit=
 *     List notifications newest-first. Returns `{ notifications, unreadCount }`.
 *
 *   POST   /api/notifications
 *     Create a notification. Body: { title, body?, category?, priority?,
 *     deepLink?, groupKey?, source?, data? }. Returns `{ notification }`.
 *
 *   POST   /api/notifications/read-all
 *     Mark every notification read. Returns `{ changed }`.
 *
 *   POST   /api/notifications/:id/read
 *     Mark one notification read. Returns `{ ok }`.
 *
 *   DELETE /api/notifications/:id
 *     Remove one notification. Returns `{ ok }`.
 *
 *   DELETE /api/notifications
 *     Clear the inbox. Returns `{ ok }`.
 */

import type http from "node:http";
import type {
  NotificationCategory,
  NotificationInput,
  NotificationPriority,
  RouteHelpers,
} from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";

export interface NotificationRouteState {
  runtime: { getService: (type: string) => unknown } | null;
}

const CATEGORIES: NotificationCategory[] = [
  "reminder",
  "task",
  "workflow",
  "agent",
  "approval",
  "message",
  "health",
  "system",
  "general",
];
const PRIORITIES: NotificationPriority[] = ["low", "normal", "high", "urgent"];

function getService(state: NotificationRouteState): NotificationService | null {
  const svc = state.runtime?.getService(ServiceType.NOTIFICATION);
  return svc instanceof NotificationService ? svc : null;
}

function parseLimit(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(parsed, 500);
}

function parseCategory(raw: string | null): NotificationCategory | undefined {
  if (raw && CATEGORIES.includes(raw as NotificationCategory)) {
    return raw as NotificationCategory;
  }
  return undefined;
}

/** Coerce an untrusted request body into a NotificationInput. */
function parseNotificationInput(
  body: Record<string, unknown>,
): { ok: true; input: NotificationInput } | { ok: false; message: string } {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return { ok: false, message: "title is required" };
  }
  const category =
    typeof body.category === "string" &&
    CATEGORIES.includes(body.category as NotificationCategory)
      ? (body.category as NotificationCategory)
      : undefined;
  const priority =
    typeof body.priority === "string" &&
    PRIORITIES.includes(body.priority as NotificationPriority)
      ? (body.priority as NotificationPriority)
      : undefined;
  const input: NotificationInput = {
    title,
    body:
      typeof body.body === "string" ? body.body.trim() || undefined : undefined,
    category,
    priority,
    source:
      typeof body.source === "string"
        ? body.source.trim() || undefined
        : undefined,
    deepLink:
      typeof body.deepLink === "string"
        ? body.deepLink.trim() || undefined
        : undefined,
    groupKey:
      typeof body.groupKey === "string"
        ? body.groupKey.trim() || undefined
        : undefined,
    icon:
      typeof body.icon === "string" ? body.icon.trim() || undefined : undefined,
    data:
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? (body.data as NotificationInput["data"])
        : undefined,
  };
  return { ok: true, input };
}

export async function handleNotificationRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  state: NotificationRouteState,
  helpers: RouteHelpers,
): Promise<boolean> {
  if (!pathname.startsWith("/api/notifications")) return false;

  const service = getService(state);
  if (!service) {
    // The runtime is up but the notification service isn't registered yet
    // (very early boot). Serve an empty inbox rather than 500 so the UI
    // degrades gracefully and retries.
    if (method === "GET" && pathname === "/api/notifications") {
      helpers.json(res, { notifications: [], unreadCount: 0 });
      return true;
    }
    helpers.error(res, "notification service not ready", 503);
    return true;
  }

  // ── GET /api/notifications ────────────────────────────────────────
  if (method === "GET" && pathname === "/api/notifications") {
    const url = new URL(req.url ?? pathname, "http://localhost");
    const notifications = service.list({
      unreadOnly: url.searchParams.get("unreadOnly") === "true",
      category: parseCategory(url.searchParams.get("category")),
      limit: parseLimit(url.searchParams.get("limit")),
    });
    helpers.json(res, {
      notifications,
      unreadCount: service.getUnreadCount(),
    });
    return true;
  }

  // ── POST /api/notifications ───────────────────────────────────────
  if (method === "POST" && pathname === "/api/notifications") {
    const body = await helpers.readJsonBody<Record<string, unknown>>(req, res, {
      maxBytes: 32 * 1024,
    });
    if (body === null) return true;
    const parsed = parseNotificationInput(body);
    if (!parsed.ok) {
      helpers.error(res, parsed.message, 400);
      return true;
    }
    const notification = await service.notify(parsed.input);
    helpers.json(res, { notification }, 201);
    return true;
  }

  // ── POST /api/notifications/read-all ──────────────────────────────
  if (method === "POST" && pathname === "/api/notifications/read-all") {
    const changed = await service.markAllRead();
    helpers.json(res, { changed });
    return true;
  }

  // ── POST /api/notifications/:id/read ──────────────────────────────
  const readMatch = pathname.match(/^\/api\/notifications\/([^/]+)\/read$/);
  if (method === "POST" && readMatch) {
    const ok = await service.markRead(decodeURIComponent(readMatch[1]));
    helpers.json(res, { ok });
    return true;
  }

  // ── DELETE /api/notifications ─────────────────────────────────────
  if (method === "DELETE" && pathname === "/api/notifications") {
    await service.clear();
    helpers.json(res, { ok: true });
    return true;
  }

  // ── DELETE /api/notifications/:id ─────────────────────────────────
  const idMatch = pathname.match(/^\/api\/notifications\/([^/]+)$/);
  if (method === "DELETE" && idMatch) {
    const ok = await service.remove(decodeURIComponent(idMatch[1]));
    helpers.json(res, { ok });
    return true;
  }

  helpers.error(res, "notification route not found", 404);
  return true;
}
