/**
 * Regression coverage for the Meta webhook GET verification handshake over a
 * real http.Server round trip. The registered routes are dispatched by the
 * production AgentRuntime plugin-route bridge, so request parsing and the
 * response helpers are the same code used by the standalone host.
 *
 * Meta compares the response body byte-for-byte against the `hub.challenge` it
 * sent; a JSON-quoted body (`"1158201444"`) never matches, so the callback URL
 * can never be verified. These tests pin the body to the raw challenge and the
 * Content-Type away from application/json, matching the sibling
 * src/api/whatsapp-routes.ts contract.
 */
import { createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../packages/agent/src/api/runtime-plugin-routes";
import { whatsappSetupRoutes } from "../src/setup-routes";

const APP_SECRET = "round-trip-app-secret";

interface RoundTrip {
  status: number;
  contentType: string | undefined;
  body: string;
}

async function mountAndRequest(
  runtime: IAgentRuntime,
  requestPath: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {}
): Promise<RoundTrip> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    await tryHandleRuntimePluginRoute({
      req,
      res,
      method: req.method ?? "GET",
      pathname: url.pathname,
      url,
      runtime: runtime as AgentRuntime,
      isAuthorized: () => true,
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<RoundTrip>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: requestPath,
          method: init.method ?? "GET",
          headers: init.headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: res.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      request.on("error", reject);
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeRuntime(options: {
  verifyWebhook?: (mode: string, token: string, challenge: string) => string | null;
  handleWebhook?: (event: Record<string, unknown>) => Promise<void>;
}): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    routes: whatsappSetupRoutes,
    getSetting: vi.fn((key: string) => (key === "WHATSAPP_APP_SECRET" ? APP_SECRET : undefined)),
    getService: vi.fn((serviceName: string) =>
      serviceName === "whatsapp" ? options : null
    ),
  } as never as IAgentRuntime;
}

describe("WhatsApp webhook GET verification round trip", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the raw hub.challenge as text/plain, not a JSON-quoted string", async () => {
    const challenge = "1158201444";
    const runtime = makeRuntime({ verifyWebhook: (_mode, _token, echoed) => echoed });

    const res = await mountAndRequest(
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
    const runtime = makeRuntime({ verifyWebhook: () => null });

    const res = await mountAndRequest(
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
      routes: whatsappSetupRoutes,
      getService: vi.fn(() => null),
    } as never as IAgentRuntime;

    const res = await mountAndRequest(
      runtime,
      "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=99"
    );

    expect(res.status).toBe(503);
    expect(res.contentType ?? "").toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "WhatsApp service unavailable" });
  });

  it("returns the raw POST acknowledgement after production parsing and signature verification", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const runtime = makeRuntime({ handleWebhook });
    const body = JSON.stringify({ entry: [{ changes: [] }] });
    const signature = createHmac("sha256", APP_SECRET).update(body).digest("hex");

    const res = await mountAndRequest(runtime, "/api/whatsapp/webhook", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-hub-signature-256": `sha256=${signature}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.body).toBe("EVENT_RECEIVED");
    expect(res.contentType ?? "").toContain("text/plain");
    expect(handleWebhook).toHaveBeenCalledExactlyOnceWith({ entry: [{ changes: [] }] });
  });
});
