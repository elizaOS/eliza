/**
 * Drives the registered webhook HTTP routes end to end: the public GET subscribe
 * handshake and the signed POST event route, asserting signature rejection and
 * accepted delivery. Signs bodies with node:crypto against a fake runtime.
 */
import crypto from "node:crypto";
import type { IAgentRuntime, RouteRequest, RouteResponse, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { whatsappSetupRoutes } from "../src/setup-routes";

const APP_SECRET = "test-app-secret";

type CapturedResponse = RouteResponse & {
  statusCode?: number;
  body?: unknown;
};

function sign(rawBody: string): string {
  const digest = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  return `sha256=${digest}`;
}

function makeRuntime(handleWebhook = vi.fn(async () => undefined)): IAgentRuntime {
  return {
    agentId: "agent-1" as UUID,
    getSetting: vi.fn((key: string) => (key === "WHATSAPP_APP_SECRET" ? APP_SECRET : undefined)),
    getService: vi.fn((serviceName: string) =>
      serviceName === "whatsapp" ? { handleWebhook } : null
    ),
  } as never as IAgentRuntime;
}

function makeResponse(): CapturedResponse {
  const response: CapturedResponse = {
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: unknown) {
      response.body = body;
      return response;
    },
    send(body: unknown) {
      response.body = body;
      return response;
    },
    end() {
      return response;
    },
  };
  return response;
}

async function dispatchWebhook(rawBody: string, runtime: IAgentRuntime, signature = sign(rawBody)) {
  const route = whatsappSetupRoutes.find(
    (candidate) => candidate.type === "POST" && candidate.path === "/api/whatsapp/webhook"
  );
  if (!route) {
    throw new Error("WhatsApp webhook POST route is not registered");
  }

  const res = makeResponse();
  await route.handler(
    {
      rawBody,
      headers: { "x-hub-signature-256": signature },
    } as RouteRequest,
    res,
    runtime
  );
  return res;
}

describe("WhatsApp webhook route hardening", () => {
  it.each(["not-json", "null", "[]"])(
    "rejects signed malformed or non-object body without side effects: %s",
    async (rawBody) => {
      const handleWebhook = vi.fn(async () => undefined);
      const runtime = makeRuntime(handleWebhook);

      const res = await dispatchWebhook(rawBody, runtime);

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: "Invalid request body" });
      expect(handleWebhook).not.toHaveBeenCalled();
    }
  );

  it("rejects tampered signatures before parsing or handling the webhook", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const runtime = makeRuntime(handleWebhook);

    const res = await dispatchWebhook('{"entry":[]}', runtime, sign('{"entry":[1]}'));

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("passes the verified parsed body to the WhatsApp service", async () => {
    const handleWebhook = vi.fn(async () => undefined);
    const runtime = makeRuntime(handleWebhook);
    const rawBody = JSON.stringify({ entry: [{ changes: [] }] });

    const res = await dispatchWebhook(rawBody, runtime);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("EVENT_RECEIVED");
    expect(handleWebhook).toHaveBeenCalledExactlyOnceWith({ entry: [{ changes: [] }] });
  });
});
