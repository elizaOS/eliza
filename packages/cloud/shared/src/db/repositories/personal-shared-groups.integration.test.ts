/**
 * Exercises Personal Shared group claims and bindings against isolated PGlite,
 * including atomic consumption, tenant-takeover resistance, and safe reclaim.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "71000000-0000-4000-8000-000000000001";
const ORG_B = "71000000-0000-4000-8000-000000000002";
const USER_A = "71000000-0000-4000-8000-000000000011";
const USER_B = "71000000-0000-4000-8000-000000000012";
const CHAT_ID = "chat_group_contract";
const CONNECTOR_ID = "blooio:+15550000001";
const NOW = new Date("2026-08-22T00:00:00.000Z");

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: typeof import("./personal-shared-groups").personalSharedGroupsRepository;

async function issue(input: {
  codeHash: string;
  organizationId: string;
  ownerUserId: string;
  personalAgentId: string;
  platformUserId: string;
}): Promise<void> {
  await repository.issueClaim({
    codeHash: input.codeHash,
    organizationId: input.organizationId,
    ownerUserId: input.ownerUserId,
    personalAgentId: input.personalAgentId,
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR_ID,
    issuedToPlatformUserId: input.platformUserId,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
}

async function consume(codeHash: string, platformUserId: string) {
  return repository.consumeClaimAndBind({
    codeHash,
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR_ID,
    providerChatId: CHAT_ID,
    actorPlatformUserId: platformUserId,
    verifiedAt: NOW,
  });
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import(
    "../client"
  ));
  ({ personalSharedGroupsRepository: repository } = await import(
    "./personal-shared-groups"
  ));
  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  const migration = await Bun.file(
    new URL(
      "../migrations/0297_personal_shared_group_bindings.sql",
      import.meta.url,
    ),
  ).text();
  await database.exec(migration);
  const authorityMigration = await Bun.file(
    new URL(
      "../migrations/0299_personal_shared_group_authority_version.sql",
      import.meta.url,
    ),
  ).text();
  await database.exec(authorityMigration);
  const leaseMigration = await Bun.file(
    new URL(
      "../migrations/0300_personal_shared_group_delivery_lease.sql",
      import.meta.url,
    ),
  ).text();
  await database.exec(leaseMigration);
});

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    TRUNCATE personal_shared_group_delivery_receipts,
      personal_shared_group_bindings,
      personal_shared_group_claims,
      users,
      organizations CASCADE;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER_A}'), ('${USER_B}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("personalSharedGroupsRepository", () => {
  test("consumes an actor-bound claim once and creates its deterministic binding", async () => {
    await issue({
      codeHash: "claim-a",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });

    expect(await consume("claim-a", "+15551119999")).toEqual({
      status: "invalid",
    });
    const attempts = await Promise.all([
      consume("claim-a", "+15551110001"),
      consume("claim-a", "+15551110001"),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([
      "already_used",
      "bound",
    ]);
    const result = attempts.find(({ status }) => status === "bound");
    if (result?.status !== "bound") {
      throw new Error("expected a bound claim");
    }
    expect(result.status).toBe("bound");
    expect(result.binding).toMatchObject({
      organization_id: ORG_A,
      owner_user_id: USER_A,
      personal_agent_id: "personal:owner-a",
      state: "active",
      response_policy: "mention_only",
    });
    expect(result.binding.conversation_id).toMatch(/^group:[0-9a-f-]{36}$/);
  });

  test("does not let a second tenant replace an active or suspended binding", async () => {
    await issue({
      codeHash: "claim-owner-a",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    expect((await consume("claim-owner-a", "+15551110001")).status).toBe(
      "bound",
    );

    await issue({
      codeHash: "claim-owner-b",
      organizationId: ORG_B,
      ownerUserId: USER_B,
      personalAgentId: "personal:owner-b",
      platformUserId: "+15551110002",
    });
    expect(await consume("claim-owner-b", "+15551110002")).toEqual({
      status: "already_bound",
    });
    expect(
      await repository.resolveBinding({
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR_ID,
        providerChatId: CHAT_ID,
      }),
    ).toMatchObject({
      organization_id: ORG_A,
      owner_user_id: USER_A,
      personal_agent_id: "personal:owner-a",
    });

    await repository.applyMembershipChange({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      membershipChange: "removed",
      verifiedAt: NOW,
    });
    await issue({
      codeHash: "claim-owner-b-suspended",
      organizationId: ORG_B,
      ownerUserId: USER_B,
      personalAgentId: "personal:owner-b",
      platformUserId: "+15551110002",
    });
    expect(await consume("claim-owner-b-suspended", "+15551110002")).toEqual({
      status: "already_bound",
    });
  });

  test("allows a new owner only after the prior owner explicitly revokes", async () => {
    await issue({
      codeHash: "claim-before-revoke",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const first = await consume("claim-before-revoke", "+15551110001");
    if (first.status !== "bound") throw new Error("expected first binding");
    expect(
      await repository.revokeBinding({
        bindingId: first.binding.id,
        ownerUserId: USER_A,
      }),
    ).toBe(true);

    await issue({
      codeHash: "claim-after-revoke",
      organizationId: ORG_B,
      ownerUserId: USER_B,
      personalAgentId: "personal:owner-b",
      platformUserId: "+15551110002",
    });
    const rebound = await consume("claim-after-revoke", "+15551110002");
    expect(rebound.status).toBe("bound");
    if (rebound.status !== "bound") throw new Error("expected rebound claim");
    expect(rebound.binding).toMatchObject({
      organization_id: ORG_B,
      owner_user_id: USER_B,
      personal_agent_id: "personal:owner-b",
      created_by_platform_user_id: "+15551110002",
      state: "active",
    });
  });

  test("keeps a same-owner reconnect claim retryable across delivery leases", async () => {
    await issue({
      codeHash: "claim-reconnect-initial",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const initial = await consume("claim-reconnect-initial", "+15551110001");
    if (initial.status !== "bound") throw new Error("expected initial binding");
    const delivery = {
      authority: {
        bindingId: initial.binding.id,
        ownerUserId: USER_A,
        personalAgentId: "personal:owner-a",
        version: initial.binding.authority_version,
      },
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      invocation: "mention" as const,
      sourceMessageId: "incoming-reconnect",
      leaseToken: "71000000-0000-4000-8000-000000000091",
    };
    expect(await repository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
    });

    await issue({
      codeHash: "claim-reconnect-retry",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    await expect(
      consume("claim-reconnect-retry", "+15551110001"),
    ).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
    });

    await getPgliteClientForTests().exec(`
      UPDATE personal_shared_group_bindings
      SET delivery_lease_expires_at = now() - interval '1 second'
      WHERE id = '${initial.binding.id}';
    `);
    const reconnected = await consume("claim-reconnect-retry", "+15551110001");
    if (reconnected.status !== "bound")
      throw new Error("expected reconnect after lease expiry");
    expect(reconnected.binding).toMatchObject({
      owner_user_id: USER_A,
      authority_version: initial.binding.authority_version + 1,
      delivery_lease_source_id: null,
      delivery_lease_token: null,
      delivery_lease_expires_at: null,
      delivery_lease_committed_at: null,
    });
  });

  test("serializes committed delivery before reconnect and revoked-owner takeover", async () => {
    await issue({
      codeHash: "claim-committed-initial",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const initial = await consume("claim-committed-initial", "+15551110001");
    if (initial.status !== "bound") throw new Error("expected initial binding");
    const delivery = {
      authority: {
        bindingId: initial.binding.id,
        ownerUserId: USER_A,
        personalAgentId: "personal:owner-a",
        version: initial.binding.authority_version,
      },
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      invocation: "mention" as const,
      sourceMessageId: "incoming-committed-reconnect",
      leaseToken: "71000000-0000-4000-8000-000000000092",
    };
    expect(await repository.authorizeDelivery(delivery)).toMatchObject({
      authorized: true,
    });
    expect(await repository.commitDelivery(delivery)).toBe(true);

    await issue({
      codeHash: "claim-committed-retry",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    await expect(
      consume("claim-committed-retry", "+15551110001"),
    ).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
    });
    expect(
      await repository.recordDeliveryReceipts({
        ...delivery,
        providerMessageIds: ["outgoing-committed-reconnect"],
      }),
    ).toEqual({ recorded: true, inserted: 1 });
    const reconnected = await consume("claim-committed-retry", "+15551110001");
    if (reconnected.status !== "bound")
      throw new Error("expected committed reconnect retry");
    expect(
      await repository.revokeBinding({
        bindingId: reconnected.binding.id,
        ownerUserId: USER_A,
      }),
    ).toBe(true);

    await issue({
      codeHash: "claim-revoked-takeover",
      organizationId: ORG_B,
      ownerUserId: USER_B,
      personalAgentId: "personal:owner-b",
      platformUserId: "+15551110002",
    });
    const takeover = await consume("claim-revoked-takeover", "+15551110002");
    if (takeover.status !== "bound")
      throw new Error("expected revoked-owner takeover");
    expect(takeover.binding).toMatchObject({
      owner_user_id: USER_B,
      personal_agent_id: "personal:owner-b",
      authority_version: reconnected.binding.authority_version + 2,
      delivery_lease_source_id: null,
      delivery_lease_committed_at: null,
    });
  });

  test("records provider receipts idempotently and only for an active binding", async () => {
    await issue({
      codeHash: "claim-receipts",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const bound = await consume("claim-receipts", "+15551110001");
    if (bound.status !== "bound") throw new Error("expected receipt binding");
    const receipt = {
      authority: {
        bindingId: bound.binding.id,
        ownerUserId: bound.binding.owner_user_id,
        personalAgentId: bound.binding.personal_agent_id,
        version: bound.binding.authority_version,
      },
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      sourceMessageId: "incoming-1",
      providerMessageIds: ["outgoing-1"],
      leaseToken: "71000000-0000-4000-8000-000000000099",
    };
    await repository.authorizeDelivery({
      ...receipt,
      invocation: "mention",
      sourceMessageId: receipt.sourceMessageId,
    });
    expect(await repository.commitDelivery(receipt)).toBe(true);
    expect(await repository.recordDeliveryReceipts(receipt)).toEqual({
      recorded: true,
      inserted: 1,
    });
    expect(await repository.recordDeliveryReceipts(receipt)).toEqual({
      recorded: true,
      inserted: 0,
    });
    expect(
      await repository.authorizeDelivery({
        ...receipt,
        invocation: "mention",
        leaseToken: "71000000-0000-4000-8000-000000000093",
      }),
    ).toMatchObject({ authorized: false });
    expect(
      await repository.hasDeliveryReceipt({
        bindingId: bound.binding.id,
        providerMessageId: "outgoing-1",
      }),
    ).toBe(true);
    await repository.revokeBinding({
      bindingId: bound.binding.id,
      ownerUserId: USER_A,
    });
    expect(
      await repository.recordDeliveryReceipts({
        ...receipt,
        sourceMessageId: "incoming-2",
        providerMessageIds: ["outgoing-2"],
      }),
    ).toEqual({ recorded: false, inserted: 0 });
  });

  test("invalidates in-flight delivery authority on policy and membership changes", async () => {
    await issue({
      codeHash: "claim-authority",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const bound = await consume("claim-authority", "+15551110001");
    if (bound.status !== "bound") throw new Error("expected authority binding");
    const authority = {
      bindingId: bound.binding.id,
      ownerUserId: bound.binding.owner_user_id,
      personalAgentId: bound.binding.personal_agent_id,
      version: bound.binding.authority_version,
    };
    const request = {
      authority,
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      invocation: "ambient" as const,
      sourceMessageId: "incoming-authority",
      leaseToken: "71000000-0000-4000-8000-000000000098",
    };

    expect(await repository.authorizeDelivery(request)).toMatchObject({
      authorized: false,
    });
    await repository.setResponsePolicy({
      bindingId: bound.binding.id,
      ownerUserId: USER_A,
      policy: "ambient",
    });
    expect(await repository.authorizeDelivery(request)).toMatchObject({
      authorized: false,
    });
    const refreshed = await repository.resolveBinding({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
    });
    if (!refreshed) throw new Error("expected refreshed authority");
    const refreshedRequest = {
      ...request,
      authority: { ...authority, version: refreshed.authority_version },
    };
    expect(await repository.authorizeDelivery(refreshedRequest)).toMatchObject({
      authorized: true,
    });
    expect(await repository.commitDelivery(refreshedRequest)).toBe(true);
    await getPgliteClientForTests().exec(`
      UPDATE personal_shared_group_bindings
      SET delivery_lease_expires_at = now() - interval '1 second'
      WHERE id = '${bound.binding.id}';
    `);
    let removalSettled = false;
    const removal = repository.applyMembershipChange({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      membershipChange: "removed",
      verifiedAt: NOW,
    });
    void removal.finally(() => {
      removalSettled = true;
    });
    await Bun.sleep(30);
    expect(removalSettled).toBe(false);
    expect(
      await repository.authorizeDelivery({
        ...refreshedRequest,
        leaseToken: "71000000-0000-4000-8000-000000000094",
      }),
    ).toMatchObject({ authorized: false });
    expect(
      await repository.recordDeliveryReceipts({
        ...refreshedRequest,
        leaseToken: "71000000-0000-4000-8000-000000000094",
        providerMessageIds: ["outgoing-wrong-worker"],
      }),
    ).toEqual({ recorded: false, inserted: 0 });
    await Bun.sleep(30);
    expect(removalSettled).toBe(false);
    await repository.recordDeliveryReceipts({
      ...refreshedRequest,
      sourceMessageId: refreshedRequest.sourceMessageId,
      providerMessageIds: ["outgoing-authority"],
    });
    await removal;
    expect(await repository.authorizeDelivery(refreshedRequest)).toMatchObject({
      authorized: false,
    });
    await repository.applyMembershipChange({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      membershipChange: "joined",
      verifiedAt: new Date(NOW.getTime() + 1),
    });
    const restored = await repository.resolveBinding({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
    });
    if (!restored) throw new Error("expected restored authority");
    const restoredRequest = {
      ...request,
      invocation: "mention" as const,
      authority: { ...authority, version: restored.authority_version },
    };
    const restoredLeaseToken = "71000000-0000-4000-8000-000000000097";
    const leasedRestoredRequest = {
      ...restoredRequest,
      sourceMessageId: "incoming-restored",
      leaseToken: restoredLeaseToken,
    };
    expect(
      await repository.authorizeDelivery(leasedRestoredRequest),
    ).toMatchObject({
      authorized: true,
    });
    expect(await repository.commitDelivery(leasedRestoredRequest)).toBe(true);
    const revocation = repository.revokeBinding({
      bindingId: restored.id,
      ownerUserId: USER_A,
    });
    await expect(revocation).rejects.toMatchObject({
      code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
    });
    expect(
      await repository.resolveBinding({
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR_ID,
        providerChatId: CHAT_ID,
      }),
    ).toMatchObject({ state: "active" });
    await repository.recordDeliveryReceipts({
      ...leasedRestoredRequest,
      providerMessageIds: ["outgoing-restored"],
    });
    expect(
      await repository.revokeBinding({
        bindingId: restored.id,
        ownerUserId: USER_A,
      }),
    ).toBe(true);
    expect(
      await repository.authorizeDelivery(leasedRestoredRequest),
    ).toMatchObject({
      authorized: false,
    });
  }, 10_000);

  test("fences an expired worker after the exact source delivery is reacquired", async () => {
    await issue({
      codeHash: "claim-lease-fence",
      organizationId: ORG_A,
      ownerUserId: USER_A,
      personalAgentId: "personal:owner-a",
      platformUserId: "+15551110001",
    });
    const bound = await consume("claim-lease-fence", "+15551110001");
    if (bound.status !== "bound") throw new Error("expected lease binding");
    const request = {
      authority: {
        bindingId: bound.binding.id,
        ownerUserId: bound.binding.owner_user_id,
        personalAgentId: bound.binding.personal_agent_id,
        version: bound.binding.authority_version,
      },
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      invocation: "mention" as const,
      sourceMessageId: "incoming-reacquired",
    };
    const oldLeaseToken = "71000000-0000-4000-8000-000000000095";
    const newLeaseToken = "71000000-0000-4000-8000-000000000096";
    expect(
      await repository.authorizeDelivery({
        ...request,
        leaseToken: oldLeaseToken,
      }),
    ).toMatchObject({ authorized: true, leaseToken: oldLeaseToken });
    await getPgliteClientForTests().exec(`
      UPDATE personal_shared_group_bindings
      SET delivery_lease_expires_at = now() - interval '1 second'
      WHERE id = '${bound.binding.id}';
    `);
    expect(
      await repository.authorizeDelivery({
        ...request,
        leaseToken: newLeaseToken,
      }),
    ).toMatchObject({ authorized: true, leaseToken: newLeaseToken });
    expect(
      await repository.commitDelivery({
        ...request,
        leaseToken: oldLeaseToken,
      }),
    ).toBe(false);
    expect(
      await repository.commitDelivery({
        ...request,
        leaseToken: newLeaseToken,
      }),
    ).toBe(true);
    await expect(
      repository.recordDeliveryReceipts({
        ...request,
        leaseToken: oldLeaseToken,
        providerMessageIds: ["outgoing-old-worker"],
      }),
    ).resolves.toEqual({ recorded: false, inserted: 0 });
    await expect(
      repository.recordDeliveryReceipts({
        ...request,
        leaseToken: newLeaseToken,
        providerMessageIds: ["outgoing-new-worker"],
      }),
    ).resolves.toEqual({ recorded: true, inserted: 1 });
  });
});
