/**
 * Real-DB integration tests for the Plaid item lifecycle: link, duplicate-item
 * relink, cursor sync (pagination, modified, removed, replay), item errors and
 * reauth, webhook processing, and idempotent disconnect cleanup.
 *
 * The harness boots a REAL PGLite-backed AgentRuntime (nothing about SQL or
 * row parsing is faked) and swaps only the network edge: a protocol-faithful
 * in-memory PlaidManagedClient whose /transactions/sync is keyed by cursor, so
 * duplicate and out-of-order webhook-triggered syncs replay exactly the pages
 * the real API would serve. No network, no credentials.
 */

import type { AgentRuntime } from "@elizaos/core";
import {
  type ElizaCloudManagedClientConfig,
  type PlaidExchangeResponse,
  type PlaidItemStatusResponse,
  type PlaidLinkTokenResponse,
  PlaidManagedClient,
  PlaidManagedClientError,
  type PlaidSyncResponse,
  type PlaidTransactionDto,
} from "@elizaos/plugin-elizacloud/cloud/managed-payment-clients";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { FinancesRepository } from "../src/db/finances-repository.ts";
import { FinancesService } from "../src/finances-service.ts";
import financesPlugin from "../src/plugin.ts";

process.env.ELIZA_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function txn(
  id: string,
  overrides: Partial<PlaidTransactionDto> = {},
): PlaidTransactionDto {
  return {
    transaction_id: id,
    account_id: "acct-1",
    amount: 12.5,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    date: "2026-08-01",
    authorized_date: null,
    name: `Merchant ${id}`,
    merchant_name: null,
    pending: false,
    category: null,
    personal_finance_category: { primary: "FOOD", detailed: "FOOD_FAST" },
    ...overrides,
  };
}

const STUB_CONFIG: ElizaCloudManagedClientConfig = {
  configured: true,
  apiKey: "test-key",
  apiBaseUrl: "http://cloud.invalid/api",
  siteUrl: "http://cloud.invalid",
};

/**
 * Protocol-faithful fake: sync responses are keyed by request cursor (replays
 * return the same page), and scripted failures throw the same
 * PlaidManagedClientError shape the real cloud bridge produces.
 */
class FakePlaidClient extends PlaidManagedClient {
  pages = new Map<string, PlaidSyncResponse>();
  failNextSyncWith: PlaidManagedClientError | null = null;
  itemStatus: PlaidItemStatusResponse | null = null;
  revokeCalls: string[] = [];
  revokeResult: { revoked: true } | PlaidManagedClientError = { revoked: true };
  lastLinkTokenArgs: { connectionId?: string; webhookUrl?: string } | null =
    null;
  exchangeResult: PlaidExchangeResponse | null = null;
  itemConnections = new Map<string, string>();

  constructor() {
    super(() => STUB_CONFIG);
  }

  override async createLinkToken(
    args: { connectionId?: string; webhookUrl?: string } = {},
  ): Promise<PlaidLinkTokenResponse> {
    this.lastLinkTokenArgs = args;
    return {
      linkToken: args.connectionId ? "link-update-1" : "link-new-1",
      expiration: new Date(Date.now() + 600_000).toISOString(),
      environment: "sandbox",
    };
  }

  override async exchangePublicToken(_args: {
    publicToken: string;
  }): Promise<PlaidExchangeResponse> {
    if (!this.exchangeResult) {
      throw new Error("exchangeResult not scripted");
    }
    return this.exchangeResult;
  }

  override async syncTransactions(args: {
    connectionId: string;
    cursor?: string;
    count?: number;
  }): Promise<PlaidSyncResponse> {
    if (this.failNextSyncWith) {
      const failure = this.failNextSyncWith;
      this.failNextSyncWith = null;
      throw failure;
    }
    const page = this.pages.get(args.cursor ?? "");
    if (!page) {
      throw new PlaidManagedClientError(
        400,
        "the provided cursor is not valid",
        "INVALID_FIELD",
      );
    }
    return page;
  }

  override async getItemStatus(_args: {
    connectionId: string;
  }): Promise<PlaidItemStatusResponse> {
    if (!this.itemStatus) {
      throw new Error("itemStatus not scripted");
    }
    return this.itemStatus;
  }

  override async resolveItemConnection(args: {
    itemId: string;
  }): Promise<{ connectionId: string }> {
    const connectionId = this.itemConnections.get(args.itemId);
    if (!connectionId) {
      throw new PlaidManagedClientError(404, "Plaid connection not found.");
    }
    return { connectionId };
  }

  override async revokeConnection(args: {
    connectionId: string;
  }): Promise<{ revoked: true }> {
    this.revokeCalls.push(args.connectionId);
    if (this.revokeResult instanceof PlaidManagedClientError) {
      throw this.revokeResult;
    }
    return this.revokeResult;
  }
}

function exchange(
  itemId: string,
  institutionId = "ins_1",
  accountId = `${itemId}-acct-1`,
): PlaidExchangeResponse {
  const connectionId = crypto.randomUUID();
  return {
    connectionId,
    connectionCreated: true,
    environment: "sandbox",
    institution: {
      institutionId,
      institutionName: "First Test Bank",
      primaryAccountMask: "4321",
      accounts: [
        {
          accountId,
          name: "Checking",
          mask: "4321",
          type: "depository",
          subtype: "checking",
        },
      ],
    },
  };
}

describe("Plaid item lifecycle — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: FinancesService;
  let repository: FinancesRepository;
  let fake: FakePlaidClient;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "plaid-lifecycle-tests",
      plugins: [financesPlugin],
    });
    runtime = testResult.runtime;
    service = new FinancesService(runtime);
    repository = new FinancesRepository(runtime);
    fake = new FakePlaidClient();
    service.plaidManagedClientCache = fake;
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  async function linkFreshSource(
    itemId: string,
    institutionId?: string,
    accountId?: string,
  ) {
    const result = exchange(itemId, institutionId, accountId);
    const priorConnectionId = fake.itemConnections.get(itemId);
    if (priorConnectionId) {
      result.connectionId = priorConnectionId;
      result.connectionCreated = false;
    }
    fake.itemConnections.set(itemId, result.connectionId);
    fake.exchangeResult = result;
    return service.completePlaidLink({ publicToken: `public-${itemId}` });
  }

  it("links, syncs across pages, and applies modified + removed deltas idempotently", async () => {
    const source = await linkFreshSource("item-sync");
    expect(source.status).toBe("active");

    fake.pages.set("", {
      added: [txn("t1"), txn("t2", { amount: -40 })],
      modified: [],
      removed: [],
      nextCursor: "c1",
      hasMore: true,
    });
    fake.pages.set("c1", {
      added: [txn("t3", { amount: 33.3, name: "Grocer Three" })],
      modified: [txn("t1", { amount: 99.99, name: "Merchant t1 adjusted" })],
      removed: [{ transaction_id: "t2" }],
      nextCursor: "c2",
      hasMore: false,
    });

    const first = await service.syncPlaidTransactions({ sourceId: source.id });
    expect(first).toMatchObject({
      inserted: 2,
      modified: 1,
      removed: 1,
      nextCursor: "c2",
    });

    const rows = await repository.listPaymentTransactions(runtime.agentId, {
      sourceId: source.id,
    });
    expect(rows).toHaveLength(2);
    const t1 = rows.find((row) => row.externalId === "t1");
    expect(t1?.amountUsd).toBe(99.99);
    expect(rows.find((row) => row.externalId === "t2")).toBeUndefined();

    // Duplicate / out-of-order webhook replays the sync from the persisted
    // cursor: the fake serves the terminal empty page and nothing changes.
    fake.pages.set("c2", {
      added: [],
      modified: [],
      removed: [{ transaction_id: "t2" }],
      nextCursor: "c2",
      hasMore: false,
    });
    const replay = await service.syncPlaidTransactions({ sourceId: source.id });
    expect(replay).toMatchObject({ inserted: 0, modified: 0, removed: 0 });
    expect(
      await repository.listPaymentTransactions(runtime.agentId, {
        sourceId: source.id,
      }),
    ).toHaveLength(2);
  });

  it("re-linking the same item updates the source in place and keeps the cursor", async () => {
    const before = await repository.listPaymentSources(runtime.agentId);
    const relinked = await linkFreshSource("item-sync");
    const after = await repository.listPaymentSources(runtime.agentId);
    expect(after.length).toBe(before.length);
    const plaid = relinked.metadata.plaid as { cursor: string };
    expect(plaid.cursor).toBe("c2");
  });

  it("reconsent minting a new item_id for the same accounts does not double-list", async () => {
    const before = await repository.listPaymentSources(runtime.agentId);
    const relinked = await linkFreshSource(
      "item-sync-v2",
      "ins_1",
      "item-sync-acct-1",
    );
    const after = await repository.listPaymentSources(runtime.agentId);
    expect(after.length).toBe(before.length);
    const plaid = relinked.metadata.plaid as {
      cursor: string;
      connectionId: string;
    };
    expect(plaid.connectionId).toBe(fake.itemConnections.get("item-sync-v2"));
    // New Item → cursor resets; existing transactions are retained.
    expect(plaid.cursor).toBe("");
  });

  it("marks the source needs_attention on ITEM_LOGIN_REQUIRED and recovers via update mode", async () => {
    const source = await linkFreshSource("item-reauth", "ins_reauth");
    fake.failNextSyncWith = new PlaidManagedClientError(
      400,
      "the login details of this item have changed",
      "ITEM_LOGIN_REQUIRED",
    );
    await expect(
      service.syncPlaidTransactions({ sourceId: source.id }),
    ).rejects.toMatchObject({ status: 400, code: "ITEM_LOGIN_REQUIRED" });

    const flagged = await repository.getPaymentSource(
      runtime.agentId,
      source.id,
    );
    expect(flagged?.status).toBe("needs_attention");
    const flaggedPlaid = flagged?.metadata.plaid as {
      itemError: { code: string };
    };
    expect(flaggedPlaid.itemError.code).toBe("ITEM_LOGIN_REQUIRED");

    // Update-mode Link token is created against the opaque Cloud connection.
    const token = await service.createPlaidUpdateLinkToken({
      sourceId: source.id,
    });
    expect(token.linkToken).toBe("link-update-1");
    expect(fake.lastLinkTokenArgs?.connectionId).toBe(
      (source.metadata.plaid as { connectionId: string }).connectionId,
    );

    // After Link update mode succeeds, item health is clean → active again.
    fake.itemStatus = {
      connectionId: (source.metadata.plaid as { connectionId: string })
        .connectionId,
      itemId: "item-reauth",
      institutionId: "ins_reauth",
      error: null,
      consentExpirationTime: "2026-11-01T00:00:00Z",
    };
    const recovered = await service.completePlaidUpdate({
      sourceId: source.id,
    });
    expect(recovered.status).toBe("active");
    const plaid = recovered.metadata.plaid as {
      itemError: unknown;
      consentExpirationTime: string;
    };
    expect(plaid.itemError).toBeNull();
    expect(plaid.consentExpirationTime).toBe("2026-11-01T00:00:00Z");
  });

  it("propagates rate limiting without corrupting the cursor", async () => {
    const source = await linkFreshSource("item-rate", "ins_rate");
    fake.pages.set("", {
      added: [txn("r1")],
      modified: [],
      removed: [],
      nextCursor: "rc1",
      hasMore: false,
    });
    await service.syncPlaidTransactions({ sourceId: source.id });

    fake.failNextSyncWith = new PlaidManagedClientError(
      429,
      "rate limit exceeded",
      "TRANSACTIONS_SYNC_LIMIT",
    );
    await expect(
      service.syncPlaidTransactions({ sourceId: source.id }),
    ).rejects.toMatchObject({ status: 429 });

    // Not a reauth code: the source stays active and the cursor is intact.
    const after = await repository.getPaymentSource(runtime.agentId, source.id);
    expect(after?.status).toBe("active");
    const afterPlaid = after?.metadata.plaid as { cursor: string };
    expect(afterPlaid.cursor).toBe("rc1");
  });

  it("processes verified webhooks: sync hints, reauth, revocation — duplicates safe", async () => {
    const source = await linkFreshSource("item-hook", "ins_hook");
    fake.pages.set("", {
      added: [txn("h1")],
      modified: [],
      removed: [],
      nextCursor: "hc1",
      hasMore: false,
    });
    fake.pages.set("hc1", {
      added: [],
      modified: [],
      removed: [],
      nextCursor: "hc1",
      hasMore: false,
    });

    const first = await service.processPlaidWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-hook",
    });
    expect(first).toMatchObject({ handled: true, action: "sync" });
    // Duplicate delivery replays harmlessly from the stored cursor.
    const dup = await service.processPlaidWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-hook",
    });
    expect(dup.handled).toBe(true);
    expect(
      await repository.listPaymentTransactions(runtime.agentId, {
        sourceId: source.id,
      }),
    ).toHaveLength(1);

    const reauth = await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "PENDING_EXPIRATION",
      item_id: "item-hook",
    });
    expect(reauth.action).toBe("reauth");
    expect(
      (await repository.getPaymentSource(runtime.agentId, source.id))?.status,
    ).toBe("needs_attention");

    const repaired = await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: "item-hook",
    });
    expect(repaired.action).toBe("reauth");
    expect(
      (await repository.getPaymentSource(runtime.agentId, source.id))?.status,
    ).toBe("active");

    const revokesBeforePendingDisconnect = fake.revokeCalls.length;
    const pendingDisconnect = await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "PENDING_DISCONNECT",
      item_id: "item-hook",
    });
    expect(pendingDisconnect.action).toBe("reauth");
    expect(
      (await repository.getPaymentSource(runtime.agentId, source.id))?.status,
    ).toBe("needs_attention");
    expect(fake.revokeCalls).toHaveLength(revokesBeforePendingDisconnect);
    await expect(
      service.createPlaidUpdateLinkToken({ sourceId: source.id }),
    ).resolves.toMatchObject({ linkToken: "link-update-1" });

    await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: "item-hook",
    });
    const newAccounts = await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "NEW_ACCOUNTS_AVAILABLE",
      item_id: "item-hook",
    });
    expect(newAccounts.action).toBe("none");
    const healthy = await repository.getPaymentSource(
      runtime.agentId,
      source.id,
    );
    expect(healthy).not.toBeNull();
    expect(healthy?.status).toBe("active");
    const healthyPlaid = healthy?.metadata.plaid as
      | { itemError: unknown }
      | undefined;
    expect(healthyPlaid?.itemError).toBeNull();

    const revoked = await service.processPlaidWebhook({
      webhook_type: "ITEM",
      webhook_code: "USER_PERMISSION_REVOKED",
      item_id: "item-hook",
    });
    expect(revoked.action).toBe("disconnect");
    const dead = await repository.getPaymentSource(runtime.agentId, source.id);
    expect(dead?.status).toBe("disconnected");
    expect(fake.revokeCalls).toContain(
      (source.metadata.plaid as { connectionId: string }).connectionId,
    );

    // A sync webhook for a disconnected source is recorded but not synced.
    const late = await service.processPlaidWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-hook",
    });
    expect(late.handled).toBe(false);
  });

  it("reports unknown items as unhandled rather than erroring", async () => {
    const result = await service.processPlaidWebhook({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "item-never-linked",
    });
    expect(result).toMatchObject({ handled: false, sourceId: null });
  });

  it("disconnect removes the item upstream once and is idempotent locally", async () => {
    const source = await linkFreshSource("item-bye", "ins_bye");
    fake.pages.set("", {
      added: [txn("b1")],
      modified: [],
      removed: [],
      nextCursor: "bc1",
      hasMore: false,
    });
    await service.syncPlaidTransactions({ sourceId: source.id });

    fake.revokeCalls = [];
    const first = await service.disconnectPlaidSource({ sourceId: source.id });
    expect(first.alreadyDisconnected).toBe(false);
    expect(first.source.status).toBe("disconnected");
    expect(fake.revokeCalls).toEqual([
      (source.metadata.plaid as { connectionId: string }).connectionId,
    ]);

    const second = await service.disconnectPlaidSource({ sourceId: source.id });
    expect(second.alreadyDisconnected).toBe(true);
    expect(fake.revokeCalls).toHaveLength(1);

    // History is retained after disconnect.
    expect(
      await repository.listPaymentTransactions(runtime.agentId, {
        sourceId: source.id,
      }),
    ).toHaveLength(1);
  });

  it("disconnect converges when the item is already gone upstream", async () => {
    const source = await linkFreshSource("item-gone", "ins_gone");
    fake.revokeResult = new PlaidManagedClientError(
      400,
      "item not found",
      "ITEM_NOT_FOUND",
    );
    const result = await service.disconnectPlaidSource({
      sourceId: source.id,
    });
    expect(result.source.status).toBe("disconnected");
    fake.revokeResult = { revoked: true };
  });

  it("rejects sync for a non-Plaid source and a missing source", async () => {
    const manual = await service.addPaymentSource({
      kind: "manual",
      label: "Cash",
    });
    await expect(
      service.syncPlaidTransactions({ sourceId: manual.id }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.syncPlaidTransactions({ sourceId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
