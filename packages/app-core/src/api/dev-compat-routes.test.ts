import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleDevCompatRoutes } from "./dev-compat-routes";

type CapturedResponse = http.ServerResponse & {
  bodyText: string;
  headersMap: Map<string, number | string | string[]>;
};

const originalEnv = { ...process.env };

function createState(): CompatRuntimeState {
  return {
    current: null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function createRequest(
  path: string,
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  return {
    method: "GET",
    url: path,
    headers: {
      host: "127.0.0.1",
      ...headers,
    },
    socket: {
      remoteAddress: "127.0.0.1",
    },
  } as unknown as http.IncomingMessage;
}

function createResponse(): CapturedResponse {
  const headersMap = new Map<string, number | string | string[]>();
  return {
    statusCode: 200,
    headersSent: false,
    bodyText: "",
    headersMap,
    setHeader(name: string, value: number | string | string[]) {
      headersMap.set(name.toLowerCase(), value);
      return this;
    },
    writeHead(
      statusCode: number,
      headers?: http.OutgoingHttpHeaders,
    ): http.ServerResponse {
      this.statusCode = statusCode;
      if (headers) {
        for (const [name, value] of Object.entries(headers)) {
          if (value !== undefined) {
            headersMap.set(name.toLowerCase(), value);
          }
        }
      }
      return this as unknown as http.ServerResponse;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        this.bodyText += String(chunk);
      }
      this.headersSent = true;
      return this;
    },
  } as CapturedResponse;
}

describe("dev compat routes", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "development";
    process.env.ELIZA_API_TOKEN = "dev-secret";
    delete process.env.ELIZA_ELECTROBUN_SCREENSHOT_URL;
    delete process.env.ELIZA_DESKTOP_DEV_LOG_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it.each(["/api/dev/cursor-screenshot", "/api/dev/console-log"])(
    "requires the same route auth as /api/dev/stack for %s",
    async (path) => {
      const req = createRequest(path, {
        "x-forwarded-for": "203.0.113.10",
      });
      const res = createResponse();

      await expect(
        handleDevCompatRoutes(req, res, createState()),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.bodyText)).toEqual({ error: "Unauthorized" });
    },
  );

  it.each(["/api/dev/cursor-screenshot", "/api/dev/console-log"])(
    "continues after auth succeeds for %s",
    async (path) => {
      const req = createRequest(path, {
        authorization: "Bearer dev-secret",
        "x-forwarded-for": "203.0.113.10",
      });
      const res = createResponse();

      await expect(
        handleDevCompatRoutes(req, res, createState()),
      ).resolves.toBe(true);

      expect(res.statusCode).toBe(404);
    },
  );
});
