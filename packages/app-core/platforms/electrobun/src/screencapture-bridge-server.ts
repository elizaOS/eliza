/**
 * Loopback control bridge from the child Eliza runtime to Electrobun screen capture.
 *
 * The native `ScreenCaptureManager` owns OS-level capture in the desktop host
 * process. The spawned child runtime cannot import that singleton directly, so
 * this bridge exposes the narrow frame-capture control surface over localhost
 * with a per-launch bearer token passed through environment variables.
 */

import crypto from "node:crypto";
import http from "node:http";
import { logger } from "./logger";
import { findFirstAvailableLoopbackPort } from "./native/loopback-port";
import { getScreenCaptureManager } from "./native/screencapture";

const DEFAULT_BRIDGE_PORT = 31_342;
const MAX_BODY_BYTES = 64 * 1024;

type HostFrameCaptureOptions = {
  fps?: number;
  quality?: number;
  apiBase?: string;
  endpoint?: string;
  gameUrl?: string;
};

export interface ScreenCaptureBridgeManager {
  startFrameCapture(
    options?: HostFrameCaptureOptions,
  ): Promise<{ available: boolean; reason?: string }>;
  stopFrameCapture(): Promise<{ available: boolean }>;
  isFrameCaptureActive(): Promise<{ active: boolean }>;
}

export interface StartScreenCaptureBridgeServerOptions {
  env?: NodeJS.ProcessEnv;
  manager?: ScreenCaptureBridgeManager;
  requestedPort?: number;
  token?: string;
}

class InvalidBridgeRequestError extends Error {
  readonly status = 400;
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

  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}`;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function qualityNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1 &&
    value <= 100
    ? value
    : undefined;
}

function normalizeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new InvalidBridgeRequestError("endpoint must be an absolute path");
  }
  return trimmed;
}

function normalizeLoopbackApiBase(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidBridgeRequestError("apiBase must be a valid URL");
  }

  const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
    throw new InvalidBridgeRequestError("apiBase must be an http loopback URL");
  }
  return `http://${parsed.host}`;
}

function normalizeGameUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeFrameCaptureOptions(
  body: Record<string, unknown> | null,
): HostFrameCaptureOptions {
  if (!body) return {};
  const options: HostFrameCaptureOptions = {};
  const fps = positiveNumber(body.fps);
  if (fps !== undefined) options.fps = fps;
  const quality = qualityNumber(body.quality);
  if (quality !== undefined) options.quality = quality;
  const apiBase = normalizeLoopbackApiBase(body.apiBase);
  if (apiBase !== undefined) options.apiBase = apiBase;
  const endpoint = normalizeEndpoint(body.endpoint);
  if (endpoint !== undefined) options.endpoint = endpoint;
  const gameUrl = normalizeGameUrl(body.gameUrl);
  if (gameUrl !== undefined) options.gameUrl = gameUrl;
  return options;
}

function resolveRequestedPort(
  env: NodeJS.ProcessEnv,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit;
  return (
    Number.parseInt((env.ELIZA_DESKTOP_SCREENCAPTURE_PORT ?? "").trim(), 10) ||
    DEFAULT_BRIDGE_PORT
  );
}

export async function startScreenCaptureBridgeServer(
  options: StartScreenCaptureBridgeServerOptions = {},
): Promise<() => void> {
  const env = options.env ?? process.env;
  const port = await findFirstAvailableLoopbackPort(
    resolveRequestedPort(env, options.requestedPort),
    {
      host: "127.0.0.1",
      maxHops: 32,
    },
  );
  const token =
    options.token?.trim() ||
    env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN?.trim() ||
    crypto.randomBytes(18).toString("hex");
  const baseUrl = `http://127.0.0.1:${port}`;
  const manager = options.manager ?? getScreenCaptureManager();

  env.ELIZA_DESKTOP_SCREENCAPTURE_URL = baseUrl;
  env.ELIZA_DESKTOP_SCREENCAPTURE_TOKEN = token;

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
        json(res, 200, { ok: true, active: active.active });
        return;
      }

      if (pathname === "/frame-capture/start" && method === "POST") {
        const body = await readJsonBody<Record<string, unknown>>(req);
        const result = await manager.startFrameCapture(
          normalizeFrameCaptureOptions(body),
        );
        json(res, result.available ? 200 : 503, result);
        return;
      }

      if (pathname === "/frame-capture/stop" && method === "POST") {
        json(res, 200, await manager.stopFrameCapture());
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      const status = error instanceof InvalidBridgeRequestError ? 400 : 500;
      json(res, status, {
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

  logger.info(
    `[ScreenCaptureBridge] ${baseUrl} (loopback only; token required)`,
  );

  return () => {
    server.close();
  };
}
