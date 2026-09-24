/**
 * Route-level coverage for canonical positive integer query parameters on the
 * loopback-only dev observability surface. Authorization and console-log I/O
 * are mocked; dispatch, validation, status, and response bodies are real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => ({ meta: {}, agents: {} }),
}));

vi.mock("./auth.ts", () => ({
  ensureRouteAuthorized: vi.fn(async () => true),
}));

const devConsoleMocks = vi.hoisted(() => ({
  readDevConsoleLogTail: vi.fn(() => {
    throw new Error("invalid query reached console-log I/O");
  }),
}));

vi.mock("./dev-console-log", () => ({
  isAllowedDevConsoleLogPath: () => true,
  readDevConsoleLogTail: devConsoleMocks.readDevConsoleLogTail,
}));

import { handleDevCompatRoutes } from "./dev-compat-routes";

const originalLogPath = process.env.ELIZA_DESKTOP_DEV_LOG_PATH;

afterEach(() => {
  if (originalLogPath === undefined) {
    delete process.env.ELIZA_DESKTOP_DEV_LOG_PATH;
  } else {
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH = originalLogPath;
  }
  devConsoleMocks.readDevConsoleLogTail.mockClear();
});

const STATE = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
} as CompatRuntimeState;

function request(url: string) {
  return {
    method: "GET",
    url,
    headers: {},
    socket: { remoteAddress: "127.0.0.1", localPort: 31337 },
  } as unknown as import("node:http").IncomingMessage;
}

function response() {
  const captured: { status?: number; body?: string } = {};
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(body?: string) {
      captured.status ??= res.statusCode;
      captured.body = body;
    },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };
  return { res, captured };
}

describe("dev observability query integers", () => {
  it.each([
    "/api/dev/console-log?maxLines=1e2",
    "/api/dev/console-log?maxBytes=007",
    "/api/dev/voice-latency?limit=0x10",
    "/api/dev/device-resource-metrics?limit=1e2",
    "/api/dev/inference-timing?limit=007",
  ])("returns 400 for non-canonical input on %s", async (url) => {
    process.env.ELIZA_DESKTOP_DEV_LOG_PATH =
      "/tmp/eliza/desktop-dev-console.log";
    const { res, captured } = response();

    await expect(handleDevCompatRoutes(request(url), res, STATE)).resolves.toBe(
      true,
    );

    expect(captured.status).toBe(400);
    expect(JSON.parse(captured.body ?? "{}")).toMatchObject({
      error: expect.stringContaining("canonical positive integer"),
    });
    expect(devConsoleMocks.readDevConsoleLogTail).not.toHaveBeenCalled();
  });
});
