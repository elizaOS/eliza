/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves listAccounts carries timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { ACCOUNTS_LIST_FETCH_TIMEOUT_MS } from "./client-agent-accounts";
import "./client-agent-accounts";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const list = {
  providers: [
    {
      providerId: "openai-api",
      strategy: "priority",
      accounts: [
        {
          id: "primary",
          providerId: "openai-api",
          label: "Primary",
          source: "api-key",
          enabled: true,
          priority: 0,
          createdAt: 1,
          health: "ok",
          hasCredential: true,
        },
      ],
    },
  ],
};

describe("ElizaClient accounts native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the list hop", () => {
    expect(ACCOUNTS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(list),
    );
    await makeClient(request).listAccounts();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/accounts",
      expect.any(Object),
      { timeoutMs: ACCOUNTS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled list hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
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
    await expect(makeClient(request).listAccounts(10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/accounts",
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
    await expect(makeClient(request).listAccounts()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
