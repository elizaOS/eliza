/**
 * Exercises Google disconnect at the real connector-manager/provider boundary.
 * The database and account manager are real in-memory implementations; Google
 * revocation and the durable vault are deterministic fakes so call ordering,
 * fail-closed behavior, and retry cleanup can be proven without credentials.
 */
import {
  getConnectorAccountManager,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleConnectorAccountProvider,
  revokeGoogleOAuthGrantWithFetch,
} from "./connector-account-provider.js";

const AGENT_ID = "00000000-0000-4000-8000-00000000e19a" as UUID;
const ACCOUNT_ID = "10000000-0000-4000-8000-000000000001" as UUID;
const VAULT_REF = `connector.${AGENT_ID}.google.${ACCOUNT_ID}.oauth_tokens`;

function runtimeHarness() {
  const adapter = new InMemoryDatabaseAdapter();
  const vault = new Map([
    [
      VAULT_REF,
      JSON.stringify({
        access_token: "disconnect-access-token",
        refresh_token: "disconnect-refresh-token",
      }),
    ],
  ]);
  const remove = vi.fn(async (key: string) => {
    vault.delete(key);
  });
  const revokeWatches = vi.fn(async () => undefined);
  const credentialStore = {
    get: vi.fn(async (key: string) => {
      const value = vault.get(key);
      if (value === undefined) throw new Error(`missing test credential: ${key}`);
      return value;
    }),
    has: vi.fn(async (key: string) => vault.has(key)),
    remove,
  };
  const runtime = {
    agentId: AGENT_ID,
    adapter,
    getService: (name: string) => {
      if (name === "connector_credential_store") return credentialStore;
      if (name === "calendar") {
        return { revokeGoogleCalendarWatchesByAccount: revokeWatches };
      }
      return null;
    },
    getMessageConnectors: () => [],
    registerMessageConnector: () => undefined,
    getPostConnectors: () => [],
    registerPostConnector: () => undefined,
  } as unknown as IAgentRuntime;
  return { adapter, credentialStore, remove, revokeWatches, runtime, vault };
}

async function connectedManager(harness: ReturnType<typeof runtimeHarness>) {
  await harness.adapter.initialize();
  const manager = getConnectorAccountManager(harness.runtime);
  manager.registerProvider(createGoogleConnectorAccountProvider(harness.runtime));
  await manager.upsertAccount(
    "google",
    {
      id: ACCOUNT_ID,
      provider: "google",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "owner_binding",
      status: "connected",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    },
    ACCOUNT_ID
  );
  await harness.adapter.setConnectorAccountCredentialRef({
    accountId: ACCOUNT_ID,
    credentialType: "oauth.tokens",
    vaultRef: VAULT_REF,
  });
  return manager;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google connector disconnect", () => {
  it("treats Google's documented invalid_token response as idempotent revocation", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_token" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );

    await expect(revokeGoogleOAuthGrantWithFetch("already-revoked", fetchStub)).resolves.toBe(
      undefined
    );
  });

  it("wraps transport failure as a typed fail-closed revocation error", async () => {
    const transportError = new Error("network offline");
    const fetchStub = vi.fn(async () => {
      throw transportError;
    });

    await expect(revokeGoogleOAuthGrantWithFetch("still-live", fetchStub)).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_REVOCATION_REQUEST_FAILED",
      cause: transportError,
    });
  });

  it("revokes watches and OAuth before deleting vault material, refs, and the account", async () => {
    const harness = runtimeHarness();
    const manager = await connectedManager(harness);

    await expect(manager.deleteAccount("google", ACCOUNT_ID)).resolves.toBe(true);

    const fetchStub = vi.mocked(globalThis.fetch);
    expect(fetchStub).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        body: "token=disconnect-refresh-token",
      })
    );
    expect(harness.revokeWatches).toHaveBeenCalledBefore(fetchStub);
    expect(fetchStub).toHaveBeenCalledBefore(harness.remove);
    expect(harness.vault.has(VAULT_REF)).toBe(false);
    await expect(
      harness.adapter.listConnectorAccountCredentialRefs({ accountId: ACCOUNT_ID })
    ).resolves.toEqual([]);
    await expect(harness.adapter.getConnectorAccount({ id: ACCOUNT_ID })).resolves.toBeNull();
  });

  it("keeps the connected account and credentials when Google cannot confirm revocation", async () => {
    const harness = runtimeHarness();
    const manager = await connectedManager(harness);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }))
    );

    await expect(manager.deleteAccount("google", ACCOUNT_ID)).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_REVOCATION_FAILED",
    });

    expect(harness.remove).not.toHaveBeenCalled();
    expect(harness.vault.has(VAULT_REF)).toBe(true);
    await expect(harness.adapter.getConnectorAccount({ id: ACCOUNT_ID })).resolves.toMatchObject({
      status: "connected",
      deletedAt: null,
    });
    await expect(
      harness.adapter.listConnectorAccountCredentialRefs({ accountId: ACCOUNT_ID })
    ).resolves.toHaveLength(1);
  });

  it("revokes a persisted OAuth grant even when the account already has error status", async () => {
    const harness = runtimeHarness();
    const manager = await connectedManager(harness);
    const account = await manager.getAccount("google", ACCOUNT_ID);
    if (!account) throw new Error("test account was not created");
    await manager.getStorage().upsertAccount({
      ...account,
      status: "error",
      updatedAt: Date.now(),
    });

    await expect(manager.deleteAccount("google", ACCOUNT_ID)).resolves.toBe(true);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(harness.remove).toHaveBeenCalledTimes(1);
    await expect(harness.adapter.getConnectorAccount({ id: ACCOUNT_ID })).resolves.toBeNull();
  });

  it("retries local cleanup without re-revoking an already confirmed grant", async () => {
    const harness = runtimeHarness();
    const manager = await connectedManager(harness);
    harness.remove.mockRejectedValueOnce(new Error("vault unavailable"));

    await expect(manager.deleteAccount("google", ACCOUNT_ID)).rejects.toThrow(/vault unavailable/);
    const fetchStub = vi.mocked(globalThis.fetch);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await expect(harness.adapter.getConnectorAccount({ id: ACCOUNT_ID })).resolves.toMatchObject({
      status: "error",
      metadata: { oauthRevokedAt: expect.any(String) },
    });

    await expect(manager.deleteAccount("google", ACCOUNT_ID)).resolves.toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(harness.vault.has(VAULT_REF)).toBe(false);
    await expect(
      harness.adapter.listConnectorAccountCredentialRefs({ accountId: ACCOUNT_ID })
    ).resolves.toEqual([]);
  });
});
