/**
 * Exercises Google connector deletion against deterministic credential-store,
 * revocation-endpoint, calendar-watch, and account-manager doubles. No Google
 * account or protected credential outside the fixture is touched.
 */
import type { ConnectorAccount, ConnectorAccountManager, IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleConnectorAccountProvider } from "./connector-account-provider.js";

const accountId = "3a899cd0-170f-4b3e-932e-46ec68119b35";
const vaultRef = `connector.agent.google.${accountId}.oauth_tokens`;
const tokenFixture = JSON.stringify({
  access_token: "fixture-access-token",
  refresh_token: "fixture-refresh-token",
  expiry_date: Date.now() + 60_000,
});

function harness(args: { removeFailsOnce?: boolean } = {}) {
  const order: string[] = [];
  let account: ConnectorAccount = {
    id: accountId,
    provider: "google",
    role: "OWNER",
    purpose: ["messaging", "calendar"],
    accessGate: "open",
    status: "connected",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {
      credentialRefs: [{ credentialType: "oauth.tokens", vaultRef }],
      hasRefreshToken: true,
    },
  };
  const refs = new Map([["oauth.tokens", { credentialType: "oauth.tokens", vaultRef }]]);
  const vault = new Map([[vaultRef, tokenFixture]]);
  let removeAttempts = 0;
  const listRefs = vi.fn(async () => [...refs.values()]);
  const storage = {
    getAccount: vi.fn(async () => account),
    listConnectorAccountCredentialRefs: listRefs,
  };
  const adapter = {
    listConnectorAccountCredentialRefs: listRefs,
    deleteConnectorAccountCredentialRefs: vi.fn(async () => {
      order.push("delete-refs");
      const count = refs.size;
      refs.clear();
      return count;
    }),
    appendConnectorAccountAuditEvent: vi.fn(async () => {
      order.push("audit");
    }),
  };
  const credentialStore = {
    get: vi.fn(async (ref: string) => vault.get(ref) ?? null),
    remove: vi.fn(async (ref: string) => {
      order.push("remove-vault");
      removeAttempts += 1;
      if (args.removeFailsOnce && removeAttempts === 1) {
        throw new Error("fixture vault unavailable");
      }
      vault.delete(ref);
    }),
    has: vi.fn(async (ref: string) => vault.has(ref)),
  };
  const calendar = {
    revokeGoogleCalendarWatchesByAccount: vi.fn(async () => {
      order.push("revoke-watches");
    }),
  };
  const runtime = {
    agentId: "agent",
    adapter,
    getSetting: (key: string) =>
      key === "GOOGLE_CLIENT_ID"
        ? "fixture-client-id"
        : key === "GOOGLE_CLIENT_SECRET"
          ? "fixture-client-secret"
          : undefined,
    getService: (name: string) =>
      name === "connector_credential_store"
        ? credentialStore
        : name === "calendar"
          ? calendar
          : null,
  } as unknown as IAgentRuntime;
  const manager = {
    getAccount: vi.fn(async () => account),
    getStorage: () => storage,
    upsertAccount: vi.fn(async (_provider, patch) => {
      order.push("checkpoint-account");
      account = { ...account, ...patch, updatedAt: Date.now() } as ConnectorAccount;
      return account;
    }),
  } as unknown as ConnectorAccountManager;
  const provider = createGoogleConnectorAccountProvider(runtime);
  return {
    account: () => account,
    adapter,
    calendar,
    credentialStore,
    manager,
    order,
    provider,
    refs,
    vault,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Google connector account deletion", () => {
  it("revokes provider access before watches, protected values, refs, and audit", async () => {
    const fixture = harness();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn(async () => {
        fixture.order.push("revoke-provider");
        return new Response(null, { status: 200 });
      })
    );

    await fixture.provider.deleteAccount?.(accountId, fixture.manager);

    expect(fixture.order).toEqual([
      "revoke-provider",
      "checkpoint-account",
      "revoke-watches",
      "remove-vault",
      "delete-refs",
      "checkpoint-account",
      "audit",
    ]);
    expect(fixture.vault.size).toBe(0);
    expect(fixture.refs.size).toBe(0);
    expect(fixture.account()).toMatchObject({ status: "revoked" });
    expect(fixture.account().metadata).not.toHaveProperty("credentialRefs");
    expect(fixture.account().metadata).not.toHaveProperty("hasRefreshToken");
    expect(fixture.adapter.appendConnectorAccountAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          providerRevocationConfirmed: true,
          calendarWatchesRevoked: true,
          credentialRefCount: 1,
          vaultEntryCount: 1,
        }),
      })
    );
  });

  it("fails closed before local cleanup when provider revocation is unconfirmed", async () => {
    const fixture = harness();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    await expect(
      fixture.provider.deleteAccount?.(accountId, fixture.manager)
    ).rejects.toMatchObject({ code: "GOOGLE_OAUTH_REVOCATION_UNCONFIRMED" });
    expect(fixture.calendar.revokeGoogleCalendarWatchesByAccount).not.toHaveBeenCalled();
    expect(fixture.credentialStore.remove).not.toHaveBeenCalled();
    expect(fixture.adapter.deleteConnectorAccountCredentialRefs).not.toHaveBeenCalled();
    expect(fixture.account()).toMatchObject({ status: "connected" });
  });

  it("resumes cleanup after a partial failure without revoking twice", async () => {
    const fixture = harness({ removeFailsOnce: true });
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await expect(fixture.provider.deleteAccount?.(accountId, fixture.manager)).rejects.toThrow(
      "fixture vault unavailable"
    );
    expect(fixture.account()).toMatchObject({
      status: "revoked",
      metadata: { googleRevocationConfirmed: true },
    });

    await fixture.provider.deleteAccount?.(accountId, fixture.manager);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixture.refs.size).toBe(0);
    expect(fixture.vault.size).toBe(0);
  });
});
