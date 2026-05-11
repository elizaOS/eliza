import type http from "node:http";
import { ensureRouteAuthorized } from "./auth.ts";
import {
  type CompatRuntimeState,
  isLoopbackRemoteAddress,
} from "./compat-route-shared";
import {
  isAllowedDevConsoleLogPath,
  readDevConsoleLogTail,
} from "./dev-console-log";
import { buildRouteCatalog } from "./dev-route-catalog";
import { resolveDevStackFromEnv } from "./dev-stack";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";

/**
 * Dev observability routes (loopback where noted).
 *
 * - `GET /api/dev/stack`
 * - `GET /api/dev/route-catalog`
 * - `GET /api/dev/cursor-screenshot`
 * - `GET /api/dev/console-log`
 */
export async function handleDevCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/dev/")) {
    return false;
  }

  // Dev routes are disabled in production.
  if (process.env.NODE_ENV === "production") {
    sendJsonErrorResponse(res, 404, "Not found");
    return true;
  }

  // ── GET /api/dev/stack ──────────────────────────────────────────────
  if (method === "GET" && url.pathname === "/api/dev/stack") {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendJsonErrorResponse(res, 403, "loopback only");
      return true;
    }
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const payload = resolveDevStackFromEnv();
    const localPort = (req.socket as { localPort?: number } | null)?.localPort;
    if (typeof localPort === "number" && localPort > 0) {
      payload.api.listenPort = localPort;
      payload.api.baseUrl = `http://127.0.0.1:${localPort}`;
    }
    sendJsonResponse(res, 200, payload);
    return true;
  }

  // ── GET /api/dev/route-catalog ──────────────────────────────────────
  if (method === "GET" && url.pathname === "/api/dev/route-catalog") {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendJsonErrorResponse(res, 403, "loopback only");
      return true;
    }
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    sendJsonResponse(res, 200, buildRouteCatalog());
    return true;
  }

  // ── GET /api/dev/cursor-screenshot ──────────────────────────────────
  if (method === "GET" && url.pathname === "/api/dev/cursor-screenshot") {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendJsonErrorResponse(res, 403, "loopback only");
      return true;
    }
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const upstream = process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL?.trim();
    if (!upstream) {
      sendJsonResponse(res, 404, {
        error: "desktop screenshot server not enabled",
        hint: "Desktop dev enables the screenshot server by default; use dev-platform or set ELIZA_ELECTROBUN_SCREENSHOT_URL. Disable with ELIZA_DESKTOP_SCREENSHOT_SERVER=0.",
      });
      return true;
    }
    // SSRF guard: reject non-loopback upstream URLs to prevent env-injection SSRF.
    try {
      const upstreamUrl = new URL(upstream);
      const h = upstreamUrl.hostname.toLowerCase();
      if (
        h !== "127.0.0.1" &&
        h !== "localhost" &&
        h !== "[::1]" &&
        h !== "::1"
      ) {
        sendJsonErrorResponse(res, 403, "screenshot upstream must be loopback");
        return true;
      }
    } catch {
      sendJsonErrorResponse(res, 400, "invalid screenshot upstream URL");
      return true;
    }
    const token = process.env.ELIZA_SCREENSHOT_SERVER_TOKEN?.trim() ?? "";
    const base = upstream.replace(/\/$/, "");
    const target = `${base}/cursor-screenshot.png`;
    try {
      const r = await fetch(target, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        redirect: "error",
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        sendJsonResponse(
          res,
          r.status === 401 || r.status === 403 ? r.status : 502,
          {
            error: "upstream screenshot failed",
            status: r.status,
            detail: text.slice(0, 200),
          },
        );
        return true;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      res.end(buf);
      return true;
    } catch (_err) {
      sendJsonResponse(res, 502, {
        error: "screenshot proxy error",
      });
      return true;
    }
  }

  // ── GET /api/dev/console-log ────────────────────────────────────────
  if (method === "GET" && url.pathname === "/api/dev/console-log") {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      sendJsonErrorResponse(res, 403, "loopback only");
      return true;
    }
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const logPath = process.env.ELIZA_DESKTOP_DEV_LOG_PATH?.trim();
    if (!logPath || !isAllowedDevConsoleLogPath(logPath)) {
      sendJsonResponse(res, 404, {
        error: "desktop dev log not configured",
        hint: "Run via dev-platform (dev:desktop); disable file with ELIZA_DESKTOP_DEV_LOG=0.",
      });
      return true;
    }
    const maxLinesRaw = url.searchParams.get("maxLines");
    const maxBytesRaw = url.searchParams.get("maxBytes");
    const maxLines = maxLinesRaw ? Number(maxLinesRaw) : undefined;
    const maxBytes = maxBytesRaw ? Number(maxBytesRaw) : undefined;
    const result = readDevConsoleLogTail(logPath, {
      maxLines: Number.isFinite(maxLines) ? maxLines : undefined,
      maxBytes: Number.isFinite(maxBytes) ? maxBytes : undefined,
    });
    if (result.ok === false) {
      sendJsonResponse(res, 404, { error: result.error });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(result.body);
    return true;
  }

  return false;
}
