/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves listConsumerKeys carries timeoutMs into Agent.request.
 * Create / update / rotate hops stay untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS } from "./client-agent-consumer-keys";
import { ElizaClient } from "./client-base";
import "./client-agent-consumer-keys";
import { setBootConfig } from "../config/boot-config";
import type { AgentRequestTransport } from "./transport";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const list = {
  keys: [
    {
      id: "ck_1",
      label: "CI runner",
      enabled: true,
      dailyTokenQuota: null,
      keyPrefix: "elizack_ab",
      createdAt: 1,
      updatedAt: 2,
    },
  ],
};

describe("ElizaClient consumer-keys native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the list hop", () => {
    expect(CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(list),
    );
    await makeClient(request).listConsumerKeys();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/accounts/consumer-keys",
      expect.any(Object),
      { timeoutMs: CONSUMER_KEYS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled list hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        return new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(
      makeClient(request).listConsumerKeys(10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/accounts/consumer-keys",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).listConsumerKeys()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
