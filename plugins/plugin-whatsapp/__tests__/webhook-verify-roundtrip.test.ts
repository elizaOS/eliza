/**
 * Regression coverage for the Meta webhook GET verification handshake over a
 * real http.Server round trip. The registered `whatsappSetupRoutes` GET handler
 * is invoked behind a RouteResponse shim copied byte-for-byte from the runtime
 * adapter (packages/agent/src/api/runtime-plugin-routes.ts
 * attachExpressResponseHelpers), so `json()` JSON-stringifies and `send()`
 * emits strings verbatim exactly as production does.
 *
 * Meta compares the response body byte-for-byte against the `hub.challenge` it
 * sent; a JSON-quoted body (`"1158201444"`) never matches, so the callback URL
 * can never be verified. These tests pin the body to the raw challenge and the
 * Content-Type away from application/json, matching the sibling
 * src/api/whatsapp-routes.ts contract.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Route, RouteRequest, RouteResponse, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappSetupRoutes } from "../src/setup-routes";

interface ExpressLikeResponse extends ServerResponse {
  status?: (code: number) => ExpressLikeResponse;
  json?: (data: unknown) => ExpressLikeResponse;
  send?: (data: unknown) => ExpressLikeResponse;
}

// Copied byte-for-byte from attachExpressResponseHelpers so the test exercises
// the exact serialization the runtime applies to plugin route responses.
function attachExpressResponseHelpers(res: ServerResponse): void {
  const r = res as ExpressLikeResponse;
  if (typeof r.status !== "function") {
    r.status = (code: number) => {
      res.statusCode = code;
      return r;
    };
  }
  if (typeof r.json !== "function") {
    r.json = (data: unknown) => {
      if (res.headersSent) return r;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
      return r;
    };
  }
  if (typeof r.send !== "function") {
    r.send = (data: unknown) => {
      if (res.headersSent) return r;
      if (typeof data === "string" || Buffer.isBuffer(data)) {
        res.end(data);
      } else {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(data));
      }
      return r;
    };
  }
}

function findRoute(type: "GET" | "POST"): Route {
  const route = whatsappSetupRoutes.find(
    (candidate) => candidate.type === type && candidate.path === "/api/whatsapp/webhook"
  );
  if (!route) {
    throw new Error(`WhatsApp webhook ${type} route is not registered`);
  }
  return route;
}

interface RoundTrip {
  status: number;
  contentType: string | undefined;
  body: string;
}

async function mountAndRequest(
  route: Route,
  runtime: IAgentRuntime,
  requestPath: string
): Promise<RoundTrip> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    attachExpressResponseHelpers(res);
    void Promise.resolve(
      route.handler(req as unknown as RouteRequest, res as unknown as RouteResponse, runtime)
    ).catch((err) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(String(err));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<RoundTrip>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: requestPath }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        })
        .on("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeRuntime(
  verifyWebhook: (mode: string, token: string, challenge: string) => string | null
): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    getService: vi.fn((serviceName: string) =>
      serviceName === "whatsapp" ? { verifyWebhook } : null
    ),
  } as never as IAgentRuntime;
}

describe("WhatsApp webhook GET verification round trip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the raw hub.challenge as text/plain, not a JSON-quoted string", async () => {
    const challenge = "1158201444";
    const runtime = makeRuntime((_mode, _token, echoed) => echoed);

    const res = await mountAndRequest(
      findRoute("GET"),
      runtime,
      `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=${challenge}`
    );

    expect(res.status).toBe(200);
    // Meta compares byte-for-byte: the body must be exactly the challenge.
    expect(res.body).toBe(challenge);
    expect(res.body).not.toBe(JSON.stringify(challenge));
    expect(res.contentType ?? "").not.toContain("application/json");
    expect(res.contentType ?? "").toContain("text/plain");
  });

  it("returns 403 with a JSON error envelope when verification fails", async () => {
    const runtime = makeRuntime(() => null);

    const res = await mountAndRequest(
      findRoute("GET"),
      runtime,
      "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"
    );

    expect(res.status).toBe(403);
    expect(res.contentType ?? "").toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "Webhook verification failed" });
  });

  it("returns 503 with a JSON error envelope when the service is unavailable", async () => {
    const runtime = {
      agentId: "agent-1" as UUID,
      getService: vi.fn(() => null),
    } as never as IAgentRuntime;

    const res = await mountAndRequest(
      findRoute("GET"),
      runtime,
      "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=99"
    );

    expect(res.status).toBe(503);
    expect(res.contentType ?? "").toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "WhatsApp service unavailable" });
  });
});
