/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the vault inventory list hop carries timeoutMs into Agent.request
 * and keeps allowNonOk. Reveal / mutate / profile hops stay untouched.
 * Not wallets. Not Finances.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS,
  rawRequestVaultInventoryList,
} from "./VaultInventoryPanel";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("VaultInventoryPanel list rawRequest native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the GET /api/secrets/inventory deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ entries: [] }),
    );
    const res = await rawRequestVaultInventoryList(
      VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/inventory",
      expect.any(Object),
      { timeoutMs: VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("returns a non-ok list response instead of throwing", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await rawRequestVaultInventoryList(
      VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/inventory",
      expect.any(Object),
      { timeoutMs: VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS },
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
      rawRequestVaultInventoryList(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/inventory",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the list hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("vault inventory unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      rawRequestVaultInventoryList(
        VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/inventory",
      expect.any(Object),
      { timeoutMs: VAULT_INVENTORY_LIST_RAW_REQUEST_TIMEOUT_MS },
    );
  });
});
