import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { farcasterWebhookRoutes } from "../routes/webhook";
import { FARCASTER_SERVICE_NAME } from "../types";

const handler = farcasterWebhookRoutes[0].handler;

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as RouteResponse & typeof res;
}

function runtime(service?: unknown): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getService: vi.fn((name: string) => (name === FARCASTER_SERVICE_NAME ? service : undefined)),
  } as unknown as IAgentRuntime;
}

async function post(body: unknown, service?: unknown) {
  const res = response();
  const rt = runtime(service);
  await handler({ body } as RouteRequest, res, rt);
  return { res, rt };
}

describe("farcaster webhook hardening", () => {
  it.each([
    null,
    {},
    { type: "" },
    { type: "cast.created", data: {} },
    { type: "cast.created", data: { hash: " ", author: { fid: 1 } } },
    { type: "cast.created", data: { hash: "0xabc", author: { fid: 0 } } },
    { type: "cast.created", data: { hash: "0xabc", author: { fid: Number.NaN } } },
    { type: "cast.created", data: { hash: "0xabc", author: { fid: 1.5 } } },
    {
      type: "cast.created",
      data: { hash: "0xabc", author: { fid: 1 }, mentioned_profiles: [{ fid: -1 }] },
    },
    {
      type: "cast.created",
      data: { hash: "0xabc", author: { fid: 1 }, parent_author: { fid: Infinity } },
    },
    { type: "cast.created", data: { hash: "0xabc", author: { fid: 1 }, parent_hash: "" } },
  ])("rejects malformed webhook payload %#", async (body) => {
    const processWebhookData = vi.fn();
    const service = {
      getManagersForAgent: vi.fn(
        () => new Map([["default", { interactions: { mode: "webhook", processWebhookData } }]])
      ),
    };

    const { res } = await post(body, service);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Invalid webhook payload",
    });
    expect(processWebhookData).not.toHaveBeenCalled();
  });

  it("routes account-specific payloads only to the selected webhook manager", async () => {
    const selected = vi.fn();
    const other = vi.fn();
    const service = {
      getManagerForAccount: vi.fn(() => ({
        interactions: { mode: "webhook", processWebhookData: selected },
      })),
      getManagersForAgent: vi.fn(
        () => new Map([["other", { interactions: { mode: "webhook", processWebhookData: other } }]])
      ),
    };
    const body = {
      type: "cast.created",
      accountId: "brand",
      data: { hash: "0xabc", text: "hello", author: { fid: 123 } },
    };

    const { res, rt } = await post(body, service);

    expect(service.getManagerForAccount).toHaveBeenCalledWith("brand", rt.agentId);
    expect(service.getManagersForAgent).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledWith(body);
    expect(other).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not broadcast account-specific payloads when the selected manager is missing", async () => {
    const other = vi.fn();
    const service = {
      getManagerForAccount: vi.fn(() => undefined),
      getManagersForAgent: vi.fn(
        () => new Map([["other", { interactions: { mode: "webhook", processWebhookData: other } }]])
      ),
    };

    const { res, rt } = await post(
      {
        type: "cast.created",
        accountId: "missing",
        data: { hash: "0xabc", text: "hello", author: { fid: 123 } },
      },
      service
    );

    expect(service.getManagerForAccount).toHaveBeenCalledWith("missing", rt.agentId);
    expect(service.getManagersForAgent).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not process non-webhook managers", async () => {
    const processWebhookData = vi.fn();
    const service = {
      getManagersForAgent: vi.fn(
        () => new Map([["default", { interactions: { mode: "polling", processWebhookData } }]])
      ),
    };

    const { res } = await post(
      { type: "cast.created", data: { hash: "0xabc", author: { fid: 123 } } },
      service
    );

    expect(processWebhookData).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("returns a generic 500 when manager processing throws", async () => {
    const error = new Error("secret failure details");
    const service = {
      getManagersForAgent: vi.fn(
        () =>
          new Map([
            [
              "default",
              {
                interactions: {
                  mode: "webhook",
                  processWebhookData: vi.fn(async () => {
                    throw error;
                  }),
                },
              },
            ],
          ])
      ),
    };

    const { res, rt } = await post(
      { type: "cast.created", data: { hash: "0xabc", author: { fid: 123 } } },
      service
    );

    expect(rt.logger.error).toHaveBeenCalledWith(error, "Webhook processing error");
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: "Internal server error",
    });
  });
});
