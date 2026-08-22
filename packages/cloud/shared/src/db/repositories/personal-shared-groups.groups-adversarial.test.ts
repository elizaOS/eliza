/**
 * Adversarial Personal Shared group claim lifecycle against isolated PGlite:
 * exact TTL-boundary expiry, reissue invalidation, cross-platform and
 * cross-connector reuse that must neither bind nor burn a live code, and the
 * silent policy reset when the same owner relinks a suspended binding.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "72000000-0000-4000-8000-000000000001";
const USER_A = "72000000-0000-4000-8000-000000000011";
const CHAT_ID = "chat_group_adversarial";
const BLOOIO_CONNECTOR = "blooio:+15550000002";
const TELEGRAM_CONNECTOR = "telegram:test-bot";
const NOW = new Date("2026-08-22T00:00:00.000Z");
const EXPIRES_AT = new Date(NOW.getTime() + 60_000);

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: typeof import("./personal-shared-groups").personalSharedGroupsRepository;

async function issue(input: {
  codeHash: string;
  platform?: "telegram" | "blooio";
  connectorAccountId?: string;
  platformUserId: string;
  expiresAt?: Date;
}): Promise<void> {
  await repository.issueClaim({
    codeHash: input.codeHash,
    organizationId: ORG_A,
    ownerUserId: USER_A,
    personalAgentId: "personal:owner-a",
    platform: input.platform ?? "blooio",
    project: "eliza-app",
    connectorAccountId: input.connectorAccountId ?? BLOOIO_CONNECTOR,
    issuedToPlatformUserId: input.platformUserId,
    expiresAt: input.expiresAt ?? EXPIRES_AT,
  });
}

async function consume(input: {
  codeHash: string;
  platform?: "telegram" | "blooio";
  connectorAccountId?: string;
  platformUserId: string;
  verifiedAt?: Date;
}) {
  return repository.consumeClaimAndBind({
    codeHash: input.codeHash,
    platform: input.platform ?? "blooio",
    project: "eliza-app",
    connectorAccountId: input.connectorAccountId ?? BLOOIO_CONNECTOR,
    providerChatId: CHAT_ID,
    actorPlatformUserId: input.platformUserId,
    verifiedAt: input.verifiedAt ?? NOW,
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
    INSERT INTO organizations (id) VALUES ('${ORG_A}');
    INSERT INTO users (id) VALUES ('${USER_A}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("personalSharedGroupsRepository adversarial claim lifecycle", () => {
  test("expires a claim at the exact boundary but honors the final live millisecond", async () => {
    await issue({ codeHash: "claim-boundary", platformUserId: "+15551110001" });

    // `gt(expires_at, now)` is strict: verification AT the expiry instant is
    // already expired, and the expired attempt must not consume the code.
    expect(
      await consume({
        codeHash: "claim-boundary",
        platformUserId: "+15551110001",
        verifiedAt: EXPIRES_AT,
      }),
    ).toEqual({ status: "expired" });
    expect(
      (
        await consume({
          codeHash: "claim-boundary",
          platformUserId: "+15551110001",
          verifiedAt: new Date(EXPIRES_AT.getTime() - 1),
        })
      ).status,
    ).toBe("bound");
  });

  test("reports a claim past its boundary as expired, not invalid", async () => {
    await issue({ codeHash: "claim-stale", platformUserId: "+15551110001" });

    expect(
      await consume({
        codeHash: "claim-stale",
        platformUserId: "+15551110001",
        verifiedAt: new Date(EXPIRES_AT.getTime() + 60_000),
      }),
    ).toEqual({ status: "expired" });
  });

  test("issuing a fresh code kills the previous unconsumed code as already_used", async () => {
    await issue({ codeHash: "claim-first", platformUserId: "+15551110001" });
    await issue({ codeHash: "claim-second", platformUserId: "+15551110001" });

    expect(
      await consume({ codeHash: "claim-first", platformUserId: "+15551110001" }),
    ).toEqual({ status: "already_used" });
    expect(
      (
        await consume({
          codeHash: "claim-second",
          platformUserId: "+15551110001",
        })
      ).status,
    ).toBe("bound");
  });

  test("a Telegram code pasted into a Blooio group neither binds nor burns the code", async () => {
    await issue({
      codeHash: "claim-telegram",
      platform: "telegram",
      connectorAccountId: TELEGRAM_CONNECTOR,
      platformUserId: "123456789",
    });

    expect(
      await consume({
        codeHash: "claim-telegram",
        platform: "blooio",
        connectorAccountId: BLOOIO_CONNECTOR,
        platformUserId: "123456789",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await repository.resolveBinding({
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: BLOOIO_CONNECTOR,
        providerChatId: CHAT_ID,
      }),
    ).toBeNull();

    // The failed UPDATE left the claim live for its real platform.
    const rebound = await consume({
      codeHash: "claim-telegram",
      platform: "telegram",
      connectorAccountId: TELEGRAM_CONNECTOR,
      platformUserId: "123456789",
    });
    expect(rebound.status).toBe("bound");
    if (rebound.status !== "bound") throw new Error("expected telegram binding");
    expect(rebound.binding).toMatchObject({
      platform: "telegram",
      connector_account_id: TELEGRAM_CONNECTOR,
      owner_user_id: USER_A,
    });
  });

  test("a code presented through the wrong connector account stays live for the right one", async () => {
    await issue({ codeHash: "claim-connector", platformUserId: "+15551110001" });

    expect(
      await consume({
        codeHash: "claim-connector",
        connectorAccountId: "blooio:+15559999999",
        platformUserId: "+15551110001",
      }),
    ).toEqual({ status: "invalid" });
    expect(
      (
        await consume({
          codeHash: "claim-connector",
          platformUserId: "+15551110001",
        })
      ).status,
    ).toBe("bound");
  });

  test("same-owner relink over a suspended binding keeps history but resets policy", async () => {
    await issue({ codeHash: "claim-relink-1", platformUserId: "+15551110001" });
    const first = await consume({
      codeHash: "claim-relink-1",
      platformUserId: "+15551110001",
    });
    if (first.status !== "bound") throw new Error("expected initial binding");

    expect(
      await repository.setResponsePolicy({
        bindingId: first.binding.id,
        ownerUserId: USER_A,
        policy: "ambient",
      }),
    ).toMatchObject({ response_policy: "ambient" });
    expect(
      await repository.applyMembershipChange({
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: BLOOIO_CONNECTOR,
        providerChatId: CHAT_ID,
        membershipChange: "removed",
        verifiedAt: NOW,
      }),
    ).toMatchObject({ state: "suspended" });

    await issue({ codeHash: "claim-relink-2", platformUserId: "+15551110001" });
    const relinked = await consume({
      codeHash: "claim-relink-2",
      platformUserId: "+15551110001",
    });
    expect(relinked.status).toBe("bound");
    if (relinked.status !== "bound") throw new Error("expected relinked binding");
    // Same row and deterministic conversation: group history continuity.
    expect(relinked.binding.id).toBe(first.binding.id);
    expect(relinked.binding.conversation_id).toBe(first.binding.conversation_id);
    // The ambient opt-in does NOT survive the relink: policy silently returns
    // to mention_only, which the owner must re-enable deliberately.
    expect(relinked.binding).toMatchObject({
      state: "active",
      response_policy: "mention_only",
      owner_user_id: USER_A,
    });
  });
});
