/**
 * DELETE /api/lifeops/money/sources/:sourceId encoding.
 *
 * Origin decoded the path segment with bare `decodeURIComponent` inside
 * `runFinancesRoute`. `new URL` accepts `/%`, `/%ZZ`, `/%2`, `/%E0%A4%A`;
 * `decodeURIComponent` then throws URIError. The finances catch only maps
 * `FinancesServiceError` and rethrows everything else, and the LifeOps
 * handler has no outer try/catch — so malformed percent-encoding 500s.
 * Fail closed through `ctx.decodePathComponent` (400) before the service.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const deletePaymentSource = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@elizaos/plugin-calendar/routes/calendar-routes", () => ({
  handleCalendarRoutes: vi.fn(async () => false),
}));

vi.mock("@elizaos/plugin-finances/finances-service", () => ({
  FinancesService: class MockFinancesService {
    deletePaymentSource = deletePaymentSource;
  },
  sanitizePaymentSourceForClient: (source: unknown) => source,
}));

const { handleLifeOpsRoutes } = await import("./lifeops-routes.js");

interface CapturedResponse {
  body: string;
  ended: boolean;
  statusCode: number;
}

function buildContext(pathname: string): {
  ctx: LifeOpsRouteContext;
  response: CapturedResponse;
} {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    configurable: true,
    value: "127.0.0.1",
  });
  const req = new IncomingMessage(socket);
  req.method = "DELETE";
  req.url = pathname;

  const captured: CapturedResponse = {
    body: "",
    ended: false,
    statusCode: 200,
  };
  const res = new ServerResponse(req);
  res.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    captured.body =
      chunk === undefined
        ? ""
        : Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
    captured.ended = true;
    captured.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const url = new URL(pathname, "http://localhost");
  const ctx: LifeOpsRouteContext = {
    req,
    res,
    method: "DELETE",
    pathname: url.pathname,
    url,
    state: {
      adminEntityId: null,
      runtime: { agentId: "agent-1" } as unknown as AgentRuntime,
    },
    json(response, data, status = 200) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    },
    error(response, message, status = 400) {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return null;
    },
    decodePathComponent(raw, response, fieldName) {
      try {
        return decodeURIComponent(raw);
      } catch {
        // error-policy:J3 same contract as server-helpers decodePathComponent.
        response.statusCode = 400;
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            error: `Invalid ${fieldName}: malformed URL encoding`,
          }),
        );
        return null;
      }
    },
  };
  return { ctx, response: captured };
}

describe("DELETE /api/lifeops/money/sources/:sourceId encoding", () => {
  beforeEach(() => {
    deletePaymentSource.mockClear();
  });

  it.each(["%", "%ZZ", "%2", "%E0%A4%A"])(
    "rejects malformed sourceId %s with 400 before deletePaymentSource",
    async (segment) => {
      const { ctx, response } = buildContext(
        `/api/lifeops/money/sources/${segment}`,
      );
      await expect(handleLifeOpsRoutes(ctx)).resolves.toBe(true);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toEqual({
        error: "Invalid sourceId: malformed URL encoding",
      });
      expect(deletePaymentSource).not.toHaveBeenCalled();
    },
  );

  it("deletes a percent-encoded sourceId after a successful decode", async () => {
    const { ctx, response } = buildContext(
      "/api/lifeops/money/sources/src%2Fbank-1",
    );
    await expect(handleLifeOpsRoutes(ctx)).resolves.toBe(true);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
    expect(deletePaymentSource).toHaveBeenCalledWith("src/bank-1");
  });
});
