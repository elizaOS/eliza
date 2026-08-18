/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves listSavedLogins carries timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { VAULT_LIST_FETCH_TIMEOUT_MS } from "./client-vault";
import "./client-vault";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const empty = { ok: true, logins: [], failures: [] };

describe("ElizaClient vault native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the list hop", () => {
    expect(VAULT_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(empty),
    );
    await makeClient(request).listSavedLogins();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
      expect.any(Object),
      { timeoutMs: VAULT_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("keeps domain query construction unchanged", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json(empty),
    );
    await makeClient(request).listSavedLogins("ex.com");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins?domain=ex.com",
      expect.any(Object),
      { timeoutMs: VAULT_LIST_FETCH_TIMEOUT_MS },
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
    await expect(
      makeClient(request).listSavedLogins(undefined, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
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
    await expect(makeClient(request).listSavedLogins()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
