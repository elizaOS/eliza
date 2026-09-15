/**
 * Proves Gmail projections with the same provider message id remain isolated
 * across Google accounts in the real local PGlite schema. No provider or
 * credential boundary is touched.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { RealTestRuntimeResult } from "../../test/helpers/runtime.js";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { lifeOpsGmailMessageFromGoogle } from "./google-plugin-delegates.js";
import {
  createLifeOpsConnectorGrant,
  createLifeOpsGmailSyncState,
  LifeOpsRepository,
} from "./repository.js";

const SYNCED_AT = "2026-08-22T18:00:00.000Z";

function grant(accountId: string) {
  return {
    ...createLifeOpsConnectorGrant({
      agentId: "fixture-agent",
      provider: "google",
      connectorAccountId: accountId,
      identity: { email: `${accountId}@example.test` },
      identityEmail: `${accountId}@example.test`,
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      capabilities: ["google.gmail.triage"],
      tokenRef: null,
      mode: "local",
      metadata: {},
      lastRefreshAt: SYNCED_AT,
    }),
    id: `connector-account:${accountId}`,
  };
}

function providerMessage() {
  return {
    externalId: "same-provider-message-id",
    threadId: "same-provider-thread-id",
    subject: "Account-isolated message",
    from: "Fixture sender",
    fromEmail: "sender@example.test",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "Fixture preview",
    receivedAt: SYNCED_AT,
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: true,
    triageScore: 70,
    triageReason: "Deterministic fixture.",
    labels: ["INBOX", "UNREAD"],
    htmlLink: null,
    metadata: {},
  };
}

describe("LifeOpsRepository Gmail account isolation", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("stores identical provider message ids independently for two grants", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const firstGrant = grant("account-1");
    const secondGrant = grant("account-2");
    const first = lifeOpsGmailMessageFromGoogle({
      agentId: runtime.agentId,
      grant: firstGrant,
      message: providerMessage(),
      syncedAt: SYNCED_AT,
    });
    const second = lifeOpsGmailMessageFromGoogle({
      agentId: runtime.agentId,
      grant: secondGrant,
      message: providerMessage(),
      syncedAt: SYNCED_AT,
    });

    expect(first.id).not.toBe(second.id);
    await repository.upsertGmailMessage(first);
    await repository.upsertGmailMessage(second);

    await expect(
      repository.listGmailMessages(
        runtime.agentId,
        "google",
        { grantId: firstGrant.id },
        "owner",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: first.id,
        connectorAccountId: "account-1",
      }),
    ]);
    await expect(
      repository.listGmailMessages(
        runtime.agentId,
        "google",
        { grantId: secondGrant.id },
        "owner",
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: second.id,
        connectorAccountId: "account-2",
      }),
    ]);
  });

  it("tombstones a pre-account-scoped projection row by provider message id", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const ownerGrant = grant("account-1");
    const current = lifeOpsGmailMessageFromGoogle({
      agentId: runtime.agentId,
      grant: ownerGrant,
      message: providerMessage(),
      syncedAt: SYNCED_AT,
    });
    // Rows written before the account-scoped id format keep the legacy id but
    // the same provider message id and grant.
    const legacy = {
      ...current,
      id: `${runtime.agentId}:google:owner:gmail:legacy-provider-id`,
      externalId: "legacy-provider-id",
      threadId: "legacy-thread",
    };
    await repository.upsertGmailMessage(current);
    await repository.upsertGmailMessage(legacy);
    await expect(
      repository.listGmailMessages(
        runtime.agentId,
        "google",
        { grantId: ownerGrant.id },
        "owner",
      ),
    ).resolves.toHaveLength(2);

    await expect(
      repository.deleteGmailMessagesByExternalId(
        runtime.agentId,
        "google",
        ["legacy-provider-id"],
        "owner",
        ownerGrant.id,
      ),
    ).resolves.toBe(1);
    await expect(
      repository.deleteGmailMessagesByExternalId(
        runtime.agentId,
        "google",
        ["legacy-provider-id"],
        "owner",
        grant("account-2").id,
      ),
    ).resolves.toBe(0);

    await expect(
      repository.listGmailMessages(
        runtime.agentId,
        "google",
        { grantId: ownerGrant.id },
        "owner",
      ),
    ).resolves.toEqual([expect.objectContaining({ id: current.id })]);
  });

  it("stores identical inbox provider ids independently for two Gmail grants", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const inboxMessage = (accountId: string) => ({
      id: "gmail:same-provider-message-id",
      channel: "gmail" as const,
      sender: {
        id: "same-provider-message-id",
        displayName: "Fixture sender",
        email: "sender@example.test",
        avatarUrl: null,
      },
      subject: "Account-isolated inbox message",
      snippet: "Fixture preview",
      receivedAt: SYNCED_AT,
      unread: true,
      deepLink: null,
      sourceRef: {
        channel: "gmail" as const,
        externalId: "same-provider-message-id",
      },
      threadId: "same-provider-thread-id",
      chatType: "dm" as const,
      gmailAccountId: `connector-account:${accountId}`,
      gmailAccountEmail: `${accountId}@example.test`,
      connectorAccountId: accountId,
    });

    await repository.upsertCachedInboxMessages(runtime.agentId, [
      inboxMessage("account-1"),
      inboxMessage("account-2"),
    ]);

    const messages = await repository.listCachedInboxMessages(runtime.agentId, {
      channels: ["gmail"],
    });
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
    expect(messages.map((message) => message.sourceRef.externalId)).toEqual([
      "same-provider-message-id",
      "same-provider-message-id",
    ]);
  });

  it("rolls back the prior projection and cursor when seed publication fails", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const ownerGrant = grant("account-1");
    const prior = lifeOpsGmailMessageFromGoogle({
      agentId: runtime.agentId,
      grant: ownerGrant,
      message: providerMessage(),
      syncedAt: SYNCED_AT,
    });
    const replacement = {
      ...prior,
      externalId: "replacement",
      id: `${prior.id}:replacement`,
    };
    await repository.upsertGmailMessage(prior);

    await expect(
      repository.publishGmailSeed(
        [replacement, { ...replacement, grantId: null } as never],
        createLifeOpsGmailSyncState({
          agentId: runtime.agentId,
          provider: "google",
          side: "owner",
          mailbox: "me",
          grantId: ownerGrant.id,
          maxResults: 2,
          historyId: "history-2",
          cursorStatus: "seeded",
          fullResyncReason: null,
          syncedAt: SYNCED_AT,
        }),
      ),
    ).rejects.toThrow(/grantId/i);

    await expect(
      repository.listGmailMessages(
        runtime.agentId,
        "google",
        { grantId: ownerGrant.id },
        "owner",
      ),
    ).resolves.toEqual([expect.objectContaining({ id: prior.id })]);
    await expect(
      repository.getGmailSyncState(
        runtime.agentId,
        "google",
        "me",
        "owner",
        ownerGrant.id,
      ),
    ).resolves.toBeNull();
  });
});
