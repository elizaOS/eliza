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
    organization_id: string;
    completed_at: string | null;
  }>(
    `SELECT state, description, failure_reason, attempt_count, claim_token,
       media_digest, organization_id, completed_at
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
  ({ personalSharedInboundMediaRepository: repository, INBOUND_MEDIA_DESCRIPTION_LEASE_MS } =
    await import("./personal-shared-inbound-media"));
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

    const reclaimed = await claimOf("msg-6", { organizationId: ORG_B, userId: USER_B });
    expect(reclaimed.id).toBe(dead.id);
    expect(reclaimed.attempt).toBe(2);
    expect(reclaimed.claimToken).not.toBe(dead.claimToken);
    expect(await ledgerRow("msg-6")).toMatchObject({
      state: "pending",
      attempt_count: 2,
      organization_id: ORG_B,
    });
    // The reclaim is a new attempt and pays the ceilings again.
    expect(await quotaRows()).toEqual([
      { scope: "connector", scope_key: `blooio:eliza-app:${CONNECTOR_ID}`, image_count: 2 },
      { scope: "sender", scope_key: ORG_A, image_count: 1 },
      { scope: "sender", scope_key: ORG_B, image_count: 1 },
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
