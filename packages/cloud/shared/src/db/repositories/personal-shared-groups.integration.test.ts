/**
 * Exercises Personal Shared group claims and bindings against isolated PGlite,
 * including atomic consumption, tenant-takeover resistance, and safe reclaim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

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
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../client"));
  ({ personalSharedGroupsRepository: repository } = await import("./personal-shared-groups"));
  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  const migration = await Bun.file(
    new URL("../migrations/0297_personal_shared_group_bindings.sql", import.meta.url),
  ).text();
  await database.exec(migration);
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
    expect(attempts.map(({ status }) => status).sort()).toEqual(["already_used", "bound"]);
    const result = attempts.find(({ status }) => status === "bound");
    if (!result || result.status !== "bound") {
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
    expect((await consume("claim-owner-a", "+15551110001")).status).toBe("bound");

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
      platform: "blooio" as const,
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      providerChatId: CHAT_ID,
      sourceMessageId: "incoming-1",
      providerMessageIds: ["outgoing-1"],
    };
    expect(await repository.recordDeliveryReceipts(receipt)).toBe(1);
    expect(await repository.recordDeliveryReceipts(receipt)).toBe(0);
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
    ).toBe(0);
  });
});
