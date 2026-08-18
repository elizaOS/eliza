/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the vault Logins tab list hop carries timeoutMs into Agent.request
 * and keeps allowNonOk. Not #21992 (client-vault listSavedLogins).
 * Autoallow / POST / DELETE stay untouched. Not wallets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../../api/client-base";
import type { AgentRequestTransport } from "../../../api/transport";
import { setBootConfig } from "../../../config/boot-config";
import {
  VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS,
  rawRequestVaultLoginsList,
} from "./LoginsTab";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("LoginsTab list rawRequest native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the list deadline to Agent.request and keeps allowNonOk", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ logins: [] }),
    );
    const res = await rawRequestVaultLoginsList(
      VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
      expect.any(Object),
      { timeoutMs: VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("returns a non-ok list response instead of throwing", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await rawRequestVaultLoginsList(
      VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
      expect.any(Object),
      { timeoutMs: VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS },
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
      rawRequestVaultLoginsList(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the list hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("vault logins unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      rawRequestVaultLoginsList(
        VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/logins",
      expect.any(Object),
      { timeoutMs: VAULT_LOGINS_LIST_RAW_REQUEST_TIMEOUT_MS },
    );
  });
});
