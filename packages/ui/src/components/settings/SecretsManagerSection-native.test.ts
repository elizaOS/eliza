/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves refreshSummary backends and preferences hops each carry their own
 * timeoutMs into Agent.request and keep allowNonOk. Modal load / sign-out
 * hops stay untouched. Not wallets. Not Finances.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../../api/client-base";
import type { AgentRequestTransport } from "../../api/transport";
import { setBootConfig } from "../../config/boot-config";
import {
  VAULT_SECRETS_BACKENDS_RAW_REQUEST_TIMEOUT_MS,
  VAULT_SECRETS_PREFERENCES_RAW_REQUEST_TIMEOUT_MS,
  rawRequestVaultSecretsBackends,
  rawRequestVaultSecretsPreferences,
} from "./SecretsManagerSection";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

function stallTransport(): AgentRequestTransport["request"] {
  return async (_url, init, ctx) => {
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
  };
}

describe("SecretsManagerSection refreshSummary native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards a separate backends deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ backends: [] }),
    );
    const res = await rawRequestVaultSecretsBackends(
      VAULT_SECRETS_BACKENDS_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/backends",
      expect.any(Object),
      { timeoutMs: VAULT_SECRETS_BACKENDS_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("forwards a separate preferences deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ preferences: { enabled: ["in-house"] } }),
    );
    const res = await rawRequestVaultSecretsPreferences(
      VAULT_SECRETS_PREFERENCES_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/preferences",
      expect.any(Object),
      { timeoutMs: VAULT_SECRETS_PREFERENCES_RAW_REQUEST_TIMEOUT_MS },
    );
  });

  it("keeps independent deadlines when both hops run together", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    const api = makeClient(request);
    const [backends, prefs] = await Promise.all([
      rawRequestVaultSecretsBackends(10, api),
      rawRequestVaultSecretsPreferences(20, api),
    ]);
    expect(backends.ok).toBe(true);
    expect(prefs.ok).toBe(true);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/backends",
      expect.any(Object),
      { timeoutMs: 10 },
    );
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/preferences",
      expect.any(Object),
      { timeoutMs: 20 },
    );
  });

  it("returns a non-ok backends response instead of throwing", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () => new Response("nope", { status: 503 }),
    );
    const res = await rawRequestVaultSecretsBackends(
      VAULT_SECRETS_BACKENDS_RAW_REQUEST_TIMEOUT_MS,
      makeClient(request),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });

  it("times out a stalled backends hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(stallTransport());
    await expect(
      rawRequestVaultSecretsBackends(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/backends",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("times out a stalled preferences hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(stallTransport());
    await expect(
      rawRequestVaultSecretsPreferences(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/secrets/manager/preferences",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the backends hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("vault backends unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      rawRequestVaultSecretsBackends(
        VAULT_SECRETS_BACKENDS_RAW_REQUEST_TIMEOUT_MS,
        makeClient(request),
      ),
    ).rejects.toMatchObject({ name: "ApiError" });
  });
});
