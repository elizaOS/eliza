/**
 * Exercises the inbound-media admission ledger against isolated PGlite with
 * the real 0310 migration: one claim per connector message id under
 * concurrency, reuse of a stored description, no retry after a terminal
 * failure, lease-fenced reclaim, and the per-sender/per-connector daily image
 * ceilings that roll a fresh claim back atomically.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "72000000-0000-4000-8000-000000000001";
const ORG_B = "72000000-0000-4000-8000-000000000002";
const USER_A = "72000000-0000-4000-8000-000000000011";
const USER_B = "72000000-0000-4000-8000-000000000012";
const CONNECTOR_ID = "+15550000001";
const OTHER_CONNECTOR_ID = "+15550000002";
const DIGEST_A = "digest-a";
const DIGEST_B = "digest-b";
const CEILINGS = { senderDailyImages: 5, connectorDailyImages: 8 };

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: typeof import("./personal-shared-inbound-media").personalSharedInboundMediaRepository;
let PersonalSharedInboundMediaRepository: typeof import("./personal-shared-inbound-media").PersonalSharedInboundMediaRepository;
let dbWrite: typeof import("../helpers").dbWrite;
let INBOUND_MEDIA_DESCRIPTION_LEASE_MS: number;

function admission(
  overrides: Partial<Parameters<typeof repository.admit>[0]> & { sourceMessageId: string },
) {
  return repository.admit({
    platform: "blooio",
    project: "eliza-app",
    connectorAccountId: CONNECTOR_ID,
    organizationId: ORG_A,
    userId: USER_A,
    mediaDigest: DIGEST_A,
    imageCount: 1,
    ceilings: CEILINGS,
    ...overrides,
  });
}

async function claimOf(sourceMessageId: string, overrides: Record<string, unknown> = {}) {
  const result = await admission({ sourceMessageId, ...overrides });
  if (result.kind !== "claimed") {
    throw new Error(`expected a claim, got ${result.kind}`);
  }
  return result.claim;
}

async function ledgerRow(sourceMessageId: string) {
  const { rows } = await getPgliteClientForTests().query<{
    state: string;
    description: string | null;
    failure_reason: string | null;
    attempt_count: number;
    claim_token: string;
    media_digest: string;
    image_count: number;
    organization_id: string;
    user_id: string;
    completed_at: string | null;
  }>(
    `SELECT state, description, failure_reason, attempt_count, claim_token,
       media_digest, image_count, organization_id, user_id, completed_at
     FROM personal_shared_inbound_media_descriptions
     WHERE source_message_id = $1`,
    [sourceMessageId],
  );
  return rows[0];
}

async function quotaRows() {
  const { rows } = await getPgliteClientForTests().query<{
    scope: string;
    scope_key: string;
    image_count: number;
  }>(
    `SELECT scope, scope_key, image_count FROM personal_shared_inbound_media_quotas
     ORDER BY scope, scope_key`,
  );
  return rows;
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../client"));
  ({
    personalSharedInboundMediaRepository: repository,
    PersonalSharedInboundMediaRepository,
    INBOUND_MEDIA_DESCRIPTION_LEASE_MS,
  } = await import("./personal-shared-inbound-media"));
  ({ dbWrite } = await import("../helpers"));
  const database = getPgliteClientForTests();
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  const migration = await Bun.file(
    new URL("../migrations/0310_personal_shared_inbound_media_admission.sql", import.meta.url),
  ).text();
  await database.exec(migration);
});

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    TRUNCATE personal_shared_inbound_media_descriptions,
      personal_shared_inbound_media_quotas,
      users,
      organizations CASCADE;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER_A}'), ('${USER_B}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("personalSharedInboundMediaRepository admission ledger", () => {
  test("claims a message once and consumes both daily ceilings atomically", async () => {
    const claim = await claimOf("msg-1", { imageCount: 2 });
    expect(claim.attempt).toBe(1);
    expect(claim.claimToken).toMatch(/^[0-9a-f-]{36}$/);

    expect(await ledgerRow("msg-1")).toMatchObject({
      state: "pending",
      attempt_count: 1,
      claim_token: claim.claimToken,
      media_digest: DIGEST_A,
      organization_id: ORG_A,
    });
    expect(await quotaRows()).toEqual([
      { scope: "connector", scope_key: `blooio:eliza-app:${CONNECTOR_ID}`, image_count: 2 },
      { scope: "sender", scope_key: ORG_A, image_count: 2 },
    ]);
  });

  test("concurrent claims of the same message admit exactly one claimant", async () => {
    const results = await Promise.all([
      admission({ sourceMessageId: "msg-race" }),
      admission({ sourceMessageId: "msg-race" }),
      admission({ sourceMessageId: "msg-race" }),
    ]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["claimed", "in_flight", "in_flight"]);
    // The losers consumed nothing: one image against each ceiling.
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([1, 1]);
  });

  test("a live claim is reported in flight, not re-spent", async () => {
    await claimOf("msg-2");
    expect(await admission({ sourceMessageId: "msg-2" })).toEqual({ kind: "in_flight" });
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([1, 1]);
  });

  test("a completed description is reused for the same media and never re-claimed", async () => {
    const claim = await claimOf("msg-3");
    expect(await repository.complete(claim, "a cat on a keyboard")).toBe(true);
    expect(await ledgerRow("msg-3")).toMatchObject({
      state: "described",
      description: "a cat on a keyboard",
      failure_reason: null,
    });
    expect((await ledgerRow("msg-3"))?.completed_at).not.toBeNull();

    expect(await admission({ sourceMessageId: "msg-3" })).toEqual({
      kind: "reused",
      description: "a cat on a keyboard",
    });
    // A redelivery whose media differs from the described claim is not a reuse.
    expect(await admission({ sourceMessageId: "msg-3", mediaDigest: DIGEST_B })).toEqual({
      kind: "media_mismatch",
    });
    // Neither redelivery touched the ceilings.
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([1, 1]);
  });

  test("a terminal failure is recorded once and never retried", async () => {
    const claim = await claimOf("msg-4");
    expect(await repository.fail(claim, "media_fetch_failed")).toBe(true);
    expect(await ledgerRow("msg-4")).toMatchObject({
      state: "failed",
      description: null,
      failure_reason: "media_fetch_failed",
    });
    expect(await admission({ sourceMessageId: "msg-4" })).toEqual({
      kind: "previously_failed",
      reason: "media_fetch_failed",
    });
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([1, 1]);
  });

  test("tenant and user identity stay immutable across pending, described, and failed rows", async () => {
    const pending = await claimOf("msg-identity-pending");
    const described = await claimOf("msg-identity-described");
    const failed = await claimOf("msg-identity-failed");
    const expired = await claimOf("msg-identity-expired");
    expect(await repository.complete(described, "private visible text")).toBe(true);
    expect(await repository.fail(failed, "media_fetch_failed")).toBe(true);
    await getPgliteClientForTests().query(
      `UPDATE personal_shared_inbound_media_descriptions
       SET lease_expires_at = now() - interval '1 second'
       WHERE source_message_id = $1`,
      ["msg-identity-expired"],
    );

    expect(
      await admission({
        sourceMessageId: "msg-identity-pending",
        userId: USER_B,
      }),
    ).toEqual({ kind: "identity_mismatch" });
    expect(
      await admission({
        sourceMessageId: "msg-identity-described",
        organizationId: ORG_B,
        userId: USER_B,
      }),
    ).toEqual({ kind: "identity_mismatch" });
    expect(
      await admission({
        sourceMessageId: "msg-identity-failed",
        organizationId: ORG_B,
        userId: USER_B,
      }),
    ).toEqual({ kind: "identity_mismatch" });
    expect(
      await admission({
        sourceMessageId: "msg-identity-expired",
        organizationId: ORG_B,
        userId: USER_B,
      }),
    ).toEqual({ kind: "identity_mismatch" });

    for (const [sourceMessageId, claim] of [
      ["msg-identity-pending", pending],
      ["msg-identity-described", described],
      ["msg-identity-failed", failed],
      ["msg-identity-expired", expired],
    ] as const) {
      expect(await ledgerRow(sourceMessageId)).toMatchObject({
        organization_id: ORG_A,
        user_id: USER_A,
        media_digest: DIGEST_A,
        image_count: 1,
        claim_token: claim.claimToken,
        attempt_count: 1,
      });
    }
    // Four original claims spent once; the mismatched replays spent nothing.
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([4, 4]);
  });

  test("payload identity is checked before every state decision and expired reclaim", async () => {
    const pending = await claimOf("msg-payload-pending");
    const described = await claimOf("msg-payload-described");
    const failed = await claimOf("msg-payload-failed");
    const expired = await claimOf("msg-payload-expired");
    expect(await repository.complete(described, "stored description")).toBe(true);
    expect(await repository.fail(failed, "media_fetch_failed")).toBe(true);
    await getPgliteClientForTests().query(
      `UPDATE personal_shared_inbound_media_descriptions
       SET lease_expires_at = now() - interval '1 second'
       WHERE source_message_id = $1`,
      ["msg-payload-expired"],
    );

    for (const sourceMessageId of [
      "msg-payload-pending",
      "msg-payload-described",
      "msg-payload-failed",
      "msg-payload-expired",
    ]) {
      expect(await admission({ sourceMessageId, mediaDigest: DIGEST_B })).toEqual({
        kind: "media_mismatch",
      });
    }
    expect(await admission({ sourceMessageId: "msg-payload-pending", imageCount: 2 })).toEqual({
      kind: "media_mismatch",
    });

    for (const [sourceMessageId, claim] of [
      ["msg-payload-pending", pending],
      ["msg-payload-described", described],
      ["msg-payload-failed", failed],
      ["msg-payload-expired", expired],
    ] as const) {
      expect(await ledgerRow(sourceMessageId)).toMatchObject({
        media_digest: DIGEST_A,
        image_count: 1,
        claim_token: claim.claimToken,
        attempt_count: 1,
      });
    }
    expect((await quotaRows()).map(({ image_count }) => image_count)).toEqual([4, 4]);
  });

  test("settlement is fenced to the live claim token and pending state", async () => {
    const claim = await claimOf("msg-5");
    const stale = { ...claim, claimToken: "00000000-0000-4000-8000-0000000000ff" };
    expect(await repository.complete(stale, "forged")).toBe(false);
    expect(await repository.fail(stale, "forged")).toBe(false);
    expect(await repository.complete(claim, "real description")).toBe(true);
    // A settled claim accepts no second outcome.
    expect(await repository.fail(claim, "late failure")).toBe(false);
    expect(await repository.complete(claim, "second description")).toBe(false);
    expect(await ledgerRow("msg-5")).toMatchObject({
      state: "described",
      description: "real description",
    });
  });

  test("only an expired lease can be reclaimed, and the reclaim fences the dead claimant", async () => {
    const dead = await claimOf("msg-6");
    await getPgliteClientForTests().query(
      `UPDATE personal_shared_inbound_media_descriptions
       SET lease_expires_at = now() - interval '1 second'
       WHERE source_message_id = $1`,
      ["msg-6"],
    );

    const reclaimed = await claimOf("msg-6");
    expect(reclaimed.id).toBe(dead.id);
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.claimToken).not.toBe(dead.claimToken);
    expect(await ledgerRow("msg-6")).toMatchObject({
      state: "pending",
      attempt_count: 2,
      organization_id: ORG_A,
      user_id: USER_A,
      media_digest: DIGEST_A,
      image_count: 1,
    });
    // The reclaim is a new attempt and pays the ceilings again.
    expect(await quotaRows()).toEqual([
      { scope: "connector", scope_key: `blooio:eliza-app:${CONNECTOR_ID}`, image_count: 2 },
      { scope: "sender", scope_key: ORG_A, image_count: 2 },
    ]);

    // The dead claimant's late settlement is rejected; the live one lands.
    expect(await repository.complete(dead, "zombie description")).toBe(false);
    expect(await repository.complete(reclaimed, "live description")).toBe(true);
    expect(await ledgerRow("msg-6")).toMatchObject({
      state: "described",
      description: "live description",
    });
  });

  test("the lease horizon outlives the gateway media-turn budget", () => {
    expect(INBOUND_MEDIA_DESCRIPTION_LEASE_MS).toBeGreaterThan(90_000);
  });

  test("renews the committed lease from the clock after quota contention", async () => {
    const startedAt = new Date("2026-08-23T12:00:00.000Z");
    const afterQuotaLocks = new Date(
      startedAt.getTime() + INBOUND_MEDIA_DESCRIPTION_LEASE_MS + 30_000,
    );
    const clocks = [startedAt, afterQuotaLocks];
    const timedRepository = new PersonalSharedInboundMediaRepository(dbWrite, async () => {
      const next = clocks.shift();
      if (!next) throw new Error("unexpected database clock read");
      return next;
    });

    const result = await timedRepository.admit({
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: CONNECTOR_ID,
      sourceMessageId: "msg-delayed-quota",
      organizationId: ORG_A,
      userId: USER_A,
      mediaDigest: DIGEST_A,
      imageCount: 1,
      ceilings: CEILINGS,
    });
    expect(result.kind).toBe("claimed");
    const { rows } = await getPgliteClientForTests().query<{ lease_expires_at: string }>(
      `SELECT lease_expires_at FROM personal_shared_inbound_media_descriptions
       WHERE source_message_id = $1`,
      ["msg-delayed-quota"],
    );
    expect(new Date(rows[0]!.lease_expires_at).getTime()).toBe(
      afterQuotaLocks.getTime() + INBOUND_MEDIA_DESCRIPTION_LEASE_MS,
    );
  });

  test("fails closed and rolls back when quota admission crosses a UTC day", async () => {
    const clocks = [new Date("2026-08-23T23:59:59.999Z"), new Date("2026-08-24T00:00:00.001Z")];
    const timedRepository = new PersonalSharedInboundMediaRepository(dbWrite, async () => {
      const next = clocks.shift();
      if (!next) throw new Error("unexpected database clock read");
      return next;
    });

    await expect(
      timedRepository.admit({
        platform: "blooio",
        project: "eliza-app",
        connectorAccountId: CONNECTOR_ID,
        sourceMessageId: "msg-utc-rollover",
        organizationId: ORG_A,
        userId: USER_A,
        mediaDigest: DIGEST_A,
        imageCount: 1,
        ceilings: CEILINGS,
      }),
    ).rejects.toMatchObject({ code: "INBOUND_MEDIA_ADMISSION_STORAGE_FAILURE" });
    expect(await ledgerRow("msg-utc-rollover")).toBeUndefined();
    expect(await quotaRows()).toEqual([]);
  });

  test("an exhausted sender ceiling denies the claim and rolls the ledger back", async () => {
    await claimOf("msg-7a", { imageCount: 4 });
    const denied = await admission({ sourceMessageId: "msg-7b", imageCount: 2 });
    expect(denied).toEqual({
      kind: "exhausted",
      scope: "sender",
      limit: CEILINGS.senderDailyImages,
      used: 4,
      requested: 2,
    });
    // The denied claim never became visible, so the same message can be
    // admitted later (for example, on the next UTC day) instead of being
    // treated as an in-flight or failed attempt.
    expect(await ledgerRow("msg-7b")).toBeUndefined();
    expect(await quotaRows()).toEqual([
      { scope: "connector", scope_key: `blooio:eliza-app:${CONNECTOR_ID}`, image_count: 4 },
      { scope: "sender", scope_key: ORG_A, image_count: 4 },
    ]);
    // Exactly the remaining budget is still admitted.
    expect((await admission({ sourceMessageId: "msg-7c", imageCount: 1 })).kind).toBe("claimed");
    expect((await admission({ sourceMessageId: "msg-7d", imageCount: 1 })).kind).toBe("exhausted");
  });

  test("an exhausted connector ceiling denies across senders and rolls the sender increment back", async () => {
    await claimOf("msg-8a", { imageCount: 4 });
    await claimOf("msg-8b", { imageCount: 4, organizationId: ORG_B, userId: USER_B });
    const denied = await admission({
      sourceMessageId: "msg-8c",
      imageCount: 1,
      organizationId: ORG_B,
      userId: USER_B,
    });
    expect(denied).toEqual({
      kind: "exhausted",
      scope: "connector",
      limit: CEILINGS.connectorDailyImages,
      used: 8,
      requested: 1,
    });
    expect(await ledgerRow("msg-8c")).toBeUndefined();
    expect(await quotaRows()).toEqual([
      { scope: "connector", scope_key: `blooio:eliza-app:${CONNECTOR_ID}`, image_count: 8 },
      { scope: "sender", scope_key: ORG_A, image_count: 4 },
      { scope: "sender", scope_key: ORG_B, image_count: 4 },
    ]);
    // Another connector account has its own ceiling.
    expect(
      (
        await admission({
          sourceMessageId: "msg-8d",
          connectorAccountId: OTHER_CONNECTOR_ID,
          organizationId: ORG_B,
          userId: USER_B,
        })
      ).kind,
    ).toBe("claimed");
  });

  test("a zero ceiling denies every description before any claim", async () => {
    expect(
      await admission({
        sourceMessageId: "msg-9",
        ceilings: { senderDailyImages: 0, connectorDailyImages: 8 },
      }),
    ).toEqual({ kind: "exhausted", scope: "sender", limit: 0, used: 0, requested: 1 });
    expect(await ledgerRow("msg-9")).toBeUndefined();
    expect(await quotaRows()).toEqual([]);
  });

  test("concurrent claimants cannot overshoot a ceiling together", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        admission({ sourceMessageId: `msg-burst-${index}`, imageCount: 1 }),
      ),
    );
    const kinds = results.map(({ kind }) => kind);
    expect(kinds.filter((kind) => kind === "claimed")).toHaveLength(CEILINGS.senderDailyImages);
    expect(kinds.filter((kind) => kind === "exhausted")).toHaveLength(
      8 - CEILINGS.senderDailyImages,
    );
    expect(await quotaRows()).toEqual([
      {
        scope: "connector",
        scope_key: `blooio:eliza-app:${CONNECTOR_ID}`,
        image_count: CEILINGS.senderDailyImages,
      },
      { scope: "sender", scope_key: ORG_A, image_count: CEILINGS.senderDailyImages },
    ]);
  });

  test("rejects malformed admission input before touching the ledger", async () => {
    await expect(admission({ sourceMessageId: "bad", imageCount: 0 })).rejects.toThrow(TypeError);
    await expect(
      admission({
        sourceMessageId: "bad",
        ceilings: { senderDailyImages: -1, connectorDailyImages: 1 },
      }),
    ).rejects.toThrow(TypeError);
    await expect(admission({ sourceMessageId: "bad", mediaDigest: "" })).rejects.toThrow(TypeError);
    expect(await ledgerRow("bad")).toBeUndefined();
  });
});
