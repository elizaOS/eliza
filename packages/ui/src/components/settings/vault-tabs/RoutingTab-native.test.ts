/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the vault Routing tab save hop carries timeoutMs into Agent.request
 * and keeps allowNonOk. Autoallow / LoginsTab / wallets stay off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../api/client-base";
import type { AgentRequestTransport } from "../../../api/transport";
import { setBootConfig } from "../../../config/boot-config";
import {
  VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS,
  rawRequestVaultRoutingSave,
} from "./RoutingTab";

const EMPTY_CONFIG = { rules: [] };

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("RoutingTab save rawRequest native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the PUT /api/secrets/routing deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ config: EMPTY_CONFIG }),
    );
    const res = await rawRequestVaultRoutingSave(
      EMPTY_CONFIG,
      VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/routing",
      expect.objectContaining({ method: "PUT" }),
      { timeoutMs: VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("returns a non-ok save response instead of throwing", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await rawRequestVaultRoutingSave(
      EMPTY_CONFIG,
      VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/routing",
      expect.objectContaining({ method: "PUT" }),
      { timeoutMs: VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("times out a stalled save hop through ElizaClient", async () => {
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
      rawRequestVaultRoutingSave(EMPTY_CONFIG, 10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/routing",
      expect.objectContaining({ method: "PUT" }),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the save hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("vault routing unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      rawRequestVaultRoutingSave(
        EMPTY_CONFIG,
        VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/routing",
      expect.objectContaining({ method: "PUT" }),
      { timeoutMs: VAULT_ROUTING_SAVE_RAW_REQUEST_TIMEOUT_MS },
    );
  });
});
