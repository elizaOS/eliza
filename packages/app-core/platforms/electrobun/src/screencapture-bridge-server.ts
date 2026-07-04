/**
 * Loopback HTTP bridge exposing the electrobun host's native screen capture to
 * the spawned agent child.
 *
 * Native frame capture (`native/screencapture.ts`) can only run in the MAIN
 * process; the agent runs as a `Bun.spawn` child, so it reaches the manager over
 * this token-guarded 127.0.0.1 server instead of a cross-process object handle
 * (#12249). The child's `DesktopScreenCaptureService` (registered as
 * `ServiceType.SCREEN_CAPTURE`) is the only caller. This mirrors
 * `browser-workspace-bridge-server.ts`; started alongside it in `index.ts`, it
 * publishes its URL + token via `ELIZA_DESKTOP_SCREENCAPTURE_URL` / `_TOKEN`
 * before the child spawns so the child inherits them.
 */

import crypto from "node:crypto";
import http from "node:http";
import { findFirstAvailableLoopbackPort } from "./native/loopback-port";
import { getScreenCaptureManager } from "./native/screencapture";

const DEFAULT_BRIDGE_PORT = 31_342;
const MAX_BODY_BYTES = 64 * 1024;

/** Frame-capture options forwarded verbatim from the child service. */
interface FrameCaptureStartBody {
  fps?: number;
  quality?: number;
  endpoint?: string;
  gameUrl?: string;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  // A random token is always generated at startup; an empty token means
  // misconfiguration, so reject rather than fail open.
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}`;
}

function json(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/**
 * Start the bridge and publish its address to the child env. Returns a stop
 * function. Callers should start this before spawning the agent child so the
 * `ELIZA_DESKTOP_SCREENCAPTURE_*` vars are inherited.
 */
export async function startScreenCaptureBridgeServer(): Promise<() => void> {
  const requestedPort =
    Number.parseInt(
      (process.env.ELIZA_DESKTOP_SCREENCAPTURE_PORT ?? "").trim(),
      10,
    ) || DEFAULT_BRIDGE_PORT;
  const port = await findFirstAvailableLoopbackPort(requestedPort, {
    host: "127.0.0.1",
    maxHops: 32,
  });
  const token =
    (process.env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN ?? "").trim() ||
    crypto.randomBytes(18).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const manager = getScreenCaptureManager();

  process.env.ELIZA_DESKTOP_SCREENCAPTURE_URL = baseUrl;
  process.env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN = token;

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopback(req.socket.remoteAddress)) {
        json(res, 403, { error: "forbidden" });
        return;
      }
      if (!isAuthorized(req, token)) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      if (pathname === "/health" && method === "GET") {
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === "/frame-capture/active" && method === "GET") {
        json(res, 200, await manager.isFrameCaptureActive());
        return;
      }

      if (pathname === "/frame-capture/start" && method === "POST") {
        const body = (await readJsonBody<FrameCaptureStartBody>(req)) ?? {};
        json(
          res,
          200,
          await manager.startFrameCapture({
            fps: body.fps,
            quality: body.quality,
            endpoint: body.endpoint,
            gameUrl: body.gameUrl,
          }),
        );
        return;
      }

      if (pathname === "/frame-capture/stop" && method === "POST") {
        json(res, 200, await manager.stopFrameCapture());
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 500, {
        error: error instanceof Error ? error.message : "internal error",
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.log(
    `[ScreenCaptureBridge] ${baseUrl} (loopback only; token required)`,
  );

  return () => {
    server.close();
  };
}
