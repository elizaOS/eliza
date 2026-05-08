import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { mockCharacter } from "../schema-data";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("ConnectorAccountStore (via BaseDrizzleAdapter delegation)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeEach(async () => {
    const setup = await createIsolatedTestDatabase("connector-account-store");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterEach(async () => {
    await cleanup?.();
  });

  it("upserts a new account, looks it up by composite key, and re-upserts with conflict update", async () => {
    const initial = await adapter.upsertConnectorAccount({
      provider: "github",
      accountKey: "user-1",
      displayName: "Alice",
      scopes: ["repo"],
      capabilities: ["pull-requests"],
      role: "OWNER",
    });
    expect(initial.id).toBeDefined();
    expect(initial.agentId).toBe(testAgentId);

    const fetched = await adapter.getConnectorAccount({
      provider: "github",
      accountKey: "user-1",
    });
    expect(fetched?.id).toBe(initial.id);
    expect(fetched?.scopes).toEqual(["repo"]);

    const updated = await adapter.upsertConnectorAccount({
      provider: "github",
      accountKey: "user-1",
      displayName: "Alice Renamed",
      scopes: ["repo", "workflow"],
    });
    expect(updated.id).toBe(initial.id);
    expect(updated.displayName).toBe("Alice Renamed");
    expect(updated.scopes).toEqual(["repo", "workflow"]);
    expect(updated.role).toBe("OWNER");
  });

  it("soft-deletes by composite key and hides the deleted account from normal reads", async () => {
    const account = await adapter.upsertConnectorAccount({
      provider: "discord",
      accountKey: "user:guild-1",
      displayName: "Bot",
    });
    const removed = await adapter.deleteConnectorAccount({
      provider: "discord",
      accountKey: "user:guild-1",
    });
    expect(removed).toBe(true);

    const after = await adapter.getConnectorAccount({ id: account.id });
    expect(after).toBeNull();

    const reconnected = await adapter.upsertConnectorAccount({
      provider: "discord",
      accountKey: "user:guild-1",
      displayName: "Bot Reconnected",
    });
    expect(reconnected.displayName).toBe("Bot Reconnected");
    expect(reconnected.deletedAt).toBeFalsy();
  });

  it("manages credential refs (set, get, list) keyed by (accountId, credentialType)", async () => {
    const account = await adapter.upsertConnectorAccount({
      provider: "stripe",
      accountKey: "acct_123",
    });

    const set1 = await adapter.setConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "api_key",
      vaultRef: `connector.${testAgentId}.stripe.${account.id}.api_key`,
      metadata: { kind: "secret" },
    });
    expect(set1.id).toBeDefined();
    expect(set1.agentId).toBe(testAgentId);
    expect(set1.provider).toBe("stripe");

    const set2 = await adapter.setConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "webhook_secret",
      vaultRef: `connector.${testAgentId}.stripe.${account.id}.webhook`,
    });

    const update = await adapter.setConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "api_key",
      vaultRef: `connector.${testAgentId}.stripe.${account.id}.api_key.v2`,
    });
    expect(update.id).toBe(set1.id);
    expect(update.vaultRef).toContain(".v2");

    const got = await adapter.getConnectorAccountCredentialRef({
      accountId: account.id,
      credentialType: "api_key",
    });
    expect(got?.vaultRef).toContain(".v2");

    const all = await adapter.listConnectorAccountCredentialRefs({
      accountId: account.id,
    });
    expect(all).toHaveLength(2);
    expect(new Set(all.map((c) => c.credentialType))).toEqual(
      new Set(["api_key", "webhook_secret"])
    );
    expect(all.every((c) => c.id === set1.id || c.id === set2.id)).toBe(true);

    await adapter.deleteConnectorAccount({
      provider: "stripe",
      accountKey: "acct_123",
    });
    await expect(
      adapter.getConnectorAccountCredentialRef({
        accountId: account.id,
        credentialType: "api_key",
      })
    ).resolves.toBeNull();
    await expect(
      adapter.listConnectorAccountCredentialRefs({
        accountId: account.id,
      })
    ).resolves.toEqual([]);
  });

  it("appends and lists audit events with redaction and filtering", async () => {
    const account = await adapter.upsertConnectorAccount({
      provider: "twitter",
      accountKey: "user-twt",
    });

    await adapter.appendConnectorAccountAuditEvent({
      accountId: account.id,
      action: "credential.set",
      outcome: "success",
      actorId: "owner:t1",
      metadata: { client_secret: "shh", note: "rotated" },
    });
    await adapter.appendConnectorAccountAuditEvent({
      accountId: account.id,
      action: "credential.set",
      outcome: "failure",
      metadata: { reason: "rejected" },
    });
    await adapter.appendConnectorAccountAuditEvent({
      accountId: account.id,
      action: "account.connected",
      metadata: {},
    });

    const adapterWithAudit = adapter as typeof adapter & {
      listConnectorAccountAuditEvents?: (p: {
        agentId?: string;
        provider?: string;
        accountId?: string;
        action?: string;
        outcome?: string;
        limit?: number;
      }) => Promise<unknown[]>;
    };
    if (typeof adapterWithAudit.listConnectorAccountAuditEvents !== "function") {
      throw new Error("listConnectorAccountAuditEvents not exposed by adapter");
    }

    const all = await adapterWithAudit.listConnectorAccountAuditEvents({
      provider: "twitter",
    });
    expect(all).toHaveLength(3);

    const onlyFailures = await adapterWithAudit.listConnectorAccountAuditEvents({
      provider: "twitter",
      outcome: "failure",
    });
    expect(onlyFailures).toHaveLength(1);

    const onlyConnect = await adapterWithAudit.listConnectorAccountAuditEvents({
      provider: "twitter",
      action: "account.connected",
    });
    expect(onlyConnect).toHaveLength(1);

    const redacted = (all as Array<{ metadata: Record<string, unknown> }>).find(
      (entry) => "client_secret" in entry.metadata
    );
    expect(redacted?.metadata.client_secret).toBe("[REDACTED]");
  });

  it("hashes oauth state, treats consume as single-use, and ignores expired flows", async () => {
    const flow = await adapter.createOAuthFlowState({
      provider: "spotify",
      state: "raw-state-1",
      ttlMs: 60_000,
      scopes: ["user-read"],
      metadata: { flowId: "oauth_spotify_1" },
    });
    expect(flow.stateHash).toHaveLength(64);
    expect(flow.stateHash).not.toBe("raw-state-1");
    await expect(
      adapter.getOAuthFlowState({
        provider: "spotify",
        flowId: "oauth_spotify_1",
        includeExpired: true,
      })
    ).resolves.toMatchObject({ stateHash: flow.stateHash });
    await expect(
      adapter.updateOAuthFlowState({
        provider: "spotify",
        flowId: "oauth_spotify_1",
        metadata: { status: "started" },
      })
    ).resolves.toMatchObject({
      metadata: expect.objectContaining({
        flowId: "oauth_spotify_1",
        status: "started",
      }),
    });
    await expect(
      adapter.getOAuthFlowState({
        agentId: "00000000-0000-0000-0000-000000000099" as UUID,
        provider: "spotify",
        flowId: "oauth_spotify_1",
        includeExpired: true,
      })
    ).resolves.toBeNull();

    const consumed = await adapter.consumeOAuthFlowState({
      provider: "spotify",
      state: "raw-state-1",
      consumedBy: "callback",
    });
    expect(consumed?.consumedBy).toBe("callback");
    expect(consumed?.stateHash).toBe(flow.stateHash);

    const consumedAgain = await adapter.consumeOAuthFlowState({
      provider: "spotify",
      state: "raw-state-1",
    });
    expect(consumedAgain).toBeNull();

    await adapter.createOAuthFlowState({
      provider: "spotify",
      state: "raw-state-2",
      expiresAt: Date.now() - 10_000,
    });
    const stale = await adapter.consumeOAuthFlowState({
      provider: "spotify",
      state: "raw-state-2",
    });
    expect(stale).toBeNull();
    await expect(
      adapter.deleteOAuthFlowState({
        provider: "spotify",
        flowId: "oauth_spotify_1",
      })
    ).resolves.toBe(true);
  });

  it("keeps identical OAuth states isolated by agent and provider", async () => {
    const sameState = "shared-raw-state";
    const otherAgentId = "00000000-0000-4000-8000-000000000123" as UUID;
    const createdOtherAgent = await adapter.createAgent({
      ...mockCharacter,
      id: otherAgentId,
      name: "Other OAuth Test Agent",
      username: "other_oauth_test_agent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    expect(createdOtherAgent).toBe(true);

    const spotify = await adapter.createOAuthFlowState({
      provider: "spotify",
      state: sameState,
      metadata: { flowId: "oauth_spotify_shared" },
    });
    const github = await adapter.createOAuthFlowState({
      provider: "github",
      state: sameState,
      metadata: { flowId: "oauth_github_shared" },
    });
    const otherAgent = await adapter.createOAuthFlowState({
      agentId: otherAgentId,
      provider: "spotify",
      state: sameState,
      metadata: { flowId: "oauth_other_agent_shared" },
    });

    expect(spotify.stateHash).toBe(github.stateHash);
    expect(otherAgent.stateHash).toBe(spotify.stateHash);

    await expect(
      adapter.consumeOAuthFlowState({
        provider: "spotify",
        state: sameState,
      })
    ).resolves.toMatchObject({ provider: "spotify", agentId: testAgentId });
    await expect(
      adapter.getOAuthFlowState({
        provider: "github",
        state: sameState,
      })
    ).resolves.toMatchObject({ provider: "github", agentId: testAgentId });
    await expect(
      adapter.getOAuthFlowState({
        agentId: otherAgentId,
        provider: "spotify",
        state: sameState,
      })
    ).resolves.toMatchObject({ provider: "spotify", agentId: otherAgentId });
  });
});
