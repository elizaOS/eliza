/**
 * Dev-only localhost server so tools can fetch a PNG without talking to WKWebView APIs.
 *
 * **Why separate HTTP in Electrobun:** the the app API process cannot capture the desktop; capture
 * runs in the shell process via ScreenCaptureManager → OS tools (e.g. macOS `screencapture`).
 *
 * **Window-scoped when possible:** to keep other windows/cursor/desktop out of agent evidence,
 * the endpoint prefers `captureWindow({ windowId })` (macOS `screencapture -l <id>`) when an Eliza
 * window id is resolvable via ELIZA_SCREENSHOT_WINDOW_ID (or an optional `?window=<id>`). When no
 * window id is available — or window capture is unavailable/errors — it falls back to full-screen
 * `takeScreenshot()`, preserving prior behavior.
 *
 * **Why loopback + optional token:** reduces accidental exposure on shared machines; dev-platform
 * generates a session token and the API proxy adds a single URL on the familiar API port.
 *
 * Enable with ELIZA_DESKTOP_SCREENSHOT_SERVER=`1` / `true` / `yes` (dev-platform sets `1` by default
 * for `dev:desktop:*`). Port: ELIZA_SCREENSHOT_SERVER_PORT (default 31339). Auth: ELIZA_SCREENSHOT_SERVER_TOKEN
 * as Bearer header only (query params not supported to avoid token leakage in logs/Referer).
 * Window capture: ELIZA_SCREENSHOT_WINDOW_ID (window id), ELIZA_SCREENSHOT_SETTLE_MS (frontmost/paint
 * settle delay before window capture, default 400ms).
 */

import http from "node:http";
import { logger } from "./logger";
import {
  getScreenCaptureManager,
  type ScreenshotCaptureResult,
} from "./native/screencapture";

/**
 * Resolve the Eliza window id for window-scoped capture. Prefers the env var
 * (set by the dev-platform when it knows the native window id); falls back to
 * an optional `?window=<id>` query param.
 *
 * Query params are forbidden for *tokens* here (secrets leak via logs/Referer),
 * but a window id is NOT a secret — it is a non-sensitive OS window handle — so
 * accepting it as a query param is acceptable.
 */
function resolveWindowId(u: URL): string | undefined {
  const fromEnv = process.env.ELIZA_SCREENSHOT_WINDOW_ID?.trim();
  if (fromEnv) return fromEnv;
  const fromQuery = u.searchParams.get("window")?.trim();
  return fromQuery ? fromQuery : undefined;
}

/**
 * Best-effort settle before window capture so the Eliza window is frontmost and
 * painted. ScreenCaptureManager exposes no activate/frontmost hook, so this is a
 * small fixed delay (overridable via ELIZA_SCREENSHOT_SETTLE_MS). darwin only —
 * other platforms fall back to full-screen capture inside captureWindow anyway.
 */
async function settleBeforeWindowCapture(): Promise<void> {
  if (process.platform !== "darwin") return;
  const raw = Number(process.env.ELIZA_SCREENSHOT_SETTLE_MS);
  const ms = Number.isFinite(raw) && raw >= 0 ? raw : 400;
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * @returns Cleanup to close the server, or `undefined` when disabled.
 */
export function startScreenshotDevServer(): (() => void) | undefined {
  const raw = process.env.ELIZA_DESKTOP_SCREENSHOT_SERVER?.trim().toLowerCase();
  const enabled = raw === "1" || raw === "true" || raw === "yes";
  if (!enabled) {
    return undefined;
  }

  const port = Number(process.env.ELIZA_SCREENSHOT_SERVER_PORT) || 31339;
  const token = process.env.ELIZA_SCREENSHOT_SERVER_TOKEN?.trim() ?? "";

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("forbidden");
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("method not allowed");
        return;
      }

      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/cursor-screenshot.png") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      if (token) {
        // Bearer-only — query param `?token=` intentionally not supported
        // to avoid token leakage in server logs and Referer headers.
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("unauthorized");
          return;
        }
      }

      const manager = getScreenCaptureManager();
      const windowId = resolveWindowId(u);
      let shot: ScreenshotCaptureResult;
      if (windowId) {
        await settleBeforeWindowCapture();
        try {
          const windowShot = await manager.captureWindow({ windowId });
          if (windowShot.available && windowShot.data) {
            logger.info(
              `[ScreenshotDev] window-scoped capture (windowId=${windowId})`,
            );
            shot = windowShot;
          } else {
            logger.warn(
              `[ScreenshotDev] window capture unavailable (windowId=${windowId}); falling back to full screen`,
            );
            shot = await manager.takeScreenshot();
          }
        } catch (err) {
          logger.warn(
            `[ScreenshotDev] window capture threw (windowId=${windowId}); falling back to full screen: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          shot = await manager.takeScreenshot();
        }
      } else {
        logger.info(
          "[ScreenshotDev] full-screen capture (no window id resolvable)",
        );
        shot = await manager.takeScreenshot();
      }
      if (!shot.available || !shot.data) {
        res.writeHead(503, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            error: "screen capture failed or unavailable",
            reason: shot.reason ?? "screen capture backend returned no image",
          }),
        );
        return;
      }

      const prefix = "data:image/png;base64,";
      const b64 = shot.data.startsWith(prefix)
        ? shot.data.slice(prefix.length)
        : shot.data.replace(/^data:[^;]+;base64,/, "");
      const buf = Buffer.from(b64, "base64");
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("error");
    }
  });

  if (!token) {
    logger.warn(
      "[ScreenshotDev] No ELIZA_SCREENSHOT_SERVER_TOKEN set — screenshot endpoint is unprotected on loopback",
    );
  }

  server.on("error", (err: NodeJS.ErrnoException) => {
    const inUse = err.code === "EADDRINUSE";
    logger.warn(
      `[ScreenshotDev] Failed to start loopback server on 127.0.0.1:${port}: ${err.message}` +
        (inUse
          ? " (port in use — set ELIZA_SCREENSHOT_SERVER_PORT to a free port or stop the other process)"
          : ""),
    );
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info(
      `[ScreenshotDev] http://127.0.0.1:${port}/cursor-screenshot.png (loopback only` +
        (token ? "; token required" : "") +
        ")",
    );
  });

  return () => {
    server.close();
  };
}
