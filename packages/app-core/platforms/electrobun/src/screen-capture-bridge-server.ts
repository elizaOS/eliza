/** Implements Electrobun desktop screen capture bridge server ts behavior for app-core shell integration. */
import crypto from "node:crypto";
import http from "node:http";
import { findFirstAvailableLoopbackPort } from "./native/loopback-port";
import { getScreenCaptureManager } from "./native/screencapture";

const DEFAULT_SCREEN_CAPTURE_BRIDGE_PORT = 31_342;
const MAX_BODY_BYTES = 64 * 1024;

type ScreenCaptureBridgeEnv = Record<string, string | undefined>;

type ScreenCaptureManagerLike = {
  isFrameCaptureActive(): Promise<{ active: boolean }> | { active: boolean };
  startFrameCapture(options?: {
    fps?: number;
    quality?: number;
    apiBase?: string;
    endpoint?: string;
    gameUrl?: string;
  }):
    | Promise<{ available: boolean; reason?: string }>
    | {
        available: boolean;
        reason?: string;
      };
  stopFrameCapture(): Promise<{ available: boolean }> | { available: boolean };
};

export interface ScreenCaptureBridgeServerOptions {
  env?: ScreenCaptureBridgeEnv;
  manager?: ScreenCaptureManagerLike;
}

function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function json(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T | null> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function pickFiniteNumber(
  value: unknown,
  options: { min?: number } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  if (typeof options.min === "number" && value < options.min) {
    return undefined;
  }
  return value;
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLoopbackHttpBase(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    // error-policy:J3 malformed URL is not a loopback base
    return false;
  }
}

function normalizeStartBody(
  body: Record<string, unknown> | null,
): Parameters<ScreenCaptureManagerLike["startFrameCapture"]>[0] {
  const apiBase = pickString(body?.apiBase);
  if (apiBase && !isLoopbackHttpBase(apiBase)) {
    throw new Error("apiBase must be a loopback http URL");
  }

  const endpoint = pickString(body?.endpoint);
  if (endpoint && !endpoint.startsWith("/")) {
    throw new Error("endpoint must be an absolute path");
  }

  const options: Parameters<ScreenCaptureManagerLike["startFrameCapture"]>[0] =
    {};
  const fps = pickFiniteNumber(body?.fps, { min: 1 });
  const quality = pickFiniteNumber(body?.quality, { min: 1 });
  const gameUrl = pickString(body?.gameUrl);
  if (fps !== undefined) options.fps = fps;
  if (quality !== undefined) options.quality = quality;
  if (apiBase) options.apiBase = apiBase;
  if (endpoint) options.endpoint = endpoint;
  if (gameUrl) options.gameUrl = gameUrl;
  return options;
}

export async function startScreenCaptureBridgeServer({
  env = process.env,
  manager = getScreenCaptureManager(),
}: ScreenCaptureBridgeServerOptions = {}): Promise<() => void> {
  const requestedPort =
    Number.parseInt(
      (env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_PORT ?? "").trim(),
      10,
    ) || DEFAULT_SCREEN_CAPTURE_BRIDGE_PORT;
  const port = await findFirstAvailableLoopbackPort(requestedPort, {
    host: "127.0.0.1",
    maxHops: 32,
  });
  const token =
    env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN?.trim() ||
    crypto.randomBytes(18).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;

  env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_URL = baseUrl;
  env.ELIZA_DESKTOP_SCREEN_CAPTURE_BRIDGE_TOKEN = token;

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
        const active = await manager.isFrameCaptureActive();
        json(res, 200, { ok: true, active: Boolean(active.active) });
        return;
      }

      if (pathname === "/frame-capture" && method === "GET") {
        const active = await manager.isFrameCaptureActive();
        json(res, 200, { active: Boolean(active.active) });
        return;
      }

      if (pathname === "/frame-capture/start" && method === "POST") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const result = await manager.startFrameCapture(
          normalizeStartBody(body),
        );
        json(res, result.available ? 200 : 409, result);
        return;
      }

      if (pathname === "/frame-capture/stop" && method === "POST") {
        const result = await manager.stopFrameCapture();
        json(res, 200, result);
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
