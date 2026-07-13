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
 *   POST   /api/notifications/dev/seed
 *     Non-production only (404 in production): seed a fixed demo spread across
 *     every priority and most categories so the dashboard notification center
 *     can be exercised without waiting for real activity. Returns
 *     `{ count, notifications }`.
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
  NotificationServiceLifecycleRuntime,
  RouteHelpers,
} from "@elizaos/core";
import { NotificationService, ServiceType } from "@elizaos/core";

export interface NotificationRouteState {
  runtime: NotificationServiceLifecycleRuntime | null;
}

const NOTIFICATION_RETRY_AFTER_SECONDS = 1;

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

/**
 * The dev/test seed spread: every priority tier, a breadth of categories, a
 * long body (exercises the widget's two-line clamp), safe deep links, and a
 * same-groupKey pair (the second collapses onto the first, proving supersede
 * behavior) — so one click paints a realistic, scrollable inbox.
 */
export const DEV_SEED_NOTIFICATIONS: readonly NotificationInput[] = [
  {
    title: "Approval needed: send weekly report",
    body: "The reporting workflow wants to email three recipients on your behalf.",
    category: "approval",
    priority: "urgent",
    source: "dev-seed",
    deepLink: "/chat",
  },
  {
    title: "Reminder: stand-up in 10 minutes",
    body: "Daily stand-up starts at 10:00.",
    category: "reminder",
    priority: "high",
    source: "dev-seed",
  },
  {
    title: "New message from Alice",
    body: "“Did you get a chance to look at the design doc?”",
    category: "message",
    priority: "normal",
    source: "dev-seed",
    deepLink: "/chat",
  },
  {
    title: "Task finished: nightly build",
    body: "All 412 tests passed in 6m 32s.",
    category: "task",
    priority: "normal",
    source: "dev-seed",
  },
  {
    title: "Health check-in",
    body: "You logged 6h 40m of sleep and a short walk this afternoon would close today's movement ring — this body intentionally runs long so list rows exercise their two-line clamp.",
    category: "health",
    priority: "low",
    source: "dev-seed",
  },
  {
    title: "Backup complete",
    body: "Workspace snapshot stored locally.",
    category: "system",
    priority: "low",
    source: "dev-seed",
  },
  {
    title: "Deploy pipeline update",
    body: "Step 2/5: building containers…",
    category: "workflow",
    priority: "normal",
    source: "dev-seed",
    groupKey: "dev-seed:deploy",
  },
  {
    title: "Deploy pipeline update",
    body: "Step 5/5: released to staging.",
    category: "workflow",
    priority: "normal",
    source: "dev-seed",
    groupKey: "dev-seed:deploy",
  },
];

function getService(state: NotificationRouteState): NotificationService | null {
  const svc = state.runtime?.getService(ServiceType.NOTIFICATION);
  return svc instanceof NotificationService ? svc : null;
}

function respondServiceUnavailable(
  res: http.ServerResponse,
  state: NotificationRouteState,
  method: string,
  pathname: string,
  helpers: RouteHelpers,
): boolean {
  const runtime = state.runtime;
  if (!runtime) {
    res.setHeader("Retry-After", String(NOTIFICATION_RETRY_AFTER_SECONDS));
    helpers.json(
      res,
      {
        error: "Notification service is still starting",
        code: "NOTIFICATION_SERVICE_NOT_READY",
        retryAfter: NOTIFICATION_RETRY_AFTER_SECONDS,
      },
      503,
    );
    return true;
  }

  const availability = NotificationService.getAvailability(runtime);
  if (availability === "disabled") {
    if (method === "GET" && pathname === "/api/notifications") {
      helpers.json(res, {
        notifications: [],
        unreadCount: 0,
        serviceStatus: "disabled",
      });
      return true;
    }
    helpers.json(
      res,
      {
        error: "Notification service is disabled",
        code: "NOTIFICATION_SERVICE_DISABLED",
      },
      503,
    );
    return true;
  }

  if (availability === "failed") {
    const recovery = NotificationService.requestRecovery(runtime);
    res.setHeader("Retry-After", String(recovery.retryAfterSeconds));
    helpers.json(
      res,
      {
        error: "Notification inbox is temporarily unavailable",
        code: "NOTIFICATION_SERVICE_FAILED",
        retryAfter: recovery.retryAfterSeconds,
      },
      503,
    );
    return true;
  }

  res.setHeader("Retry-After", String(NOTIFICATION_RETRY_AFTER_SECONDS));
  helpers.json(
    res,
    {
      error: "Notification service is still starting",
      code: "NOTIFICATION_SERVICE_NOT_READY",
      retryAfter: NOTIFICATION_RETRY_AFTER_SECONDS,
    },
    503,
  );
  return true;
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
    return respondServiceUnavailable(res, state, method, pathname, helpers);
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
      serviceStatus: "ready",
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

  // ── POST /api/notifications/dev/seed ──────────────────────────────
  if (method === "POST" && pathname === "/api/notifications/dev/seed") {
    // 404 (not 403) in production so the route's existence isn't advertised.
    if (process.env.NODE_ENV === "production") {
      helpers.error(res, "notification route not found", 404);
      return true;
    }
    const notifications = [];
    for (const input of DEV_SEED_NOTIFICATIONS) {
      notifications.push(await service.notify(input));
    }
    helpers.json(res, { count: notifications.length, notifications }, 201);
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
