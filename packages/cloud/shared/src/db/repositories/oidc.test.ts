/**
 * Proves migrations `0189_oidc_provider.sql` and `0190_oidc_request_binding.sql`
 * against the repository that uses them.
 *
 * The migration SQL is what production runs; the Drizzle schema is what the
 * code compiles against. Nothing else in the repo checks that the two agree —
 * the API-level suites push DDL from the TypeScript schema, which would happily
 * pass while the committed SQL created different columns. So this suite applies
 * the REAL migration file to PGlite and then drives every repository operation
 * over it. A column name, type, default, constraint, or index that drifts
 * between the two fails here.
 *
 * 0190 is applied over a table that already holds a 0189-era row, because that
 * is the only state a real staging or production deploy can be in and the state
 * a NOT NULL column with no default fails on.
 *
 * It also pins the concurrency behavior the OIDC flow depends on: `claimCode`
 * hands the row to exactly one of N concurrent callers, and `allocateUsername`
 * resolves a race without a transaction.
 */

import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

setDefaultTimeout(90_000);

/** Applied in order: 0190 drops and adds columns 0189 created. */
const MIGRATION_0189 = join(import.meta.dir, "../migrations/0189_oidc_provider.sql");
const MIGRATION_0190 = join(import.meta.dir, "../migrations/0190_oidc_request_binding.sql");

/**
 * A request parked by the 0189-era code, seeded BETWEEN the two migrations so
 * 0190 runs against a non-empty table. Adding a NOT NULL column with no default
 * fails outright in that state, which is the deploy this proves cannot happen.
 */
const LEGACY_REQUEST_HASH = "legacy-request-parked-before-0190";

let repository: typeof import("./oidc").oidcRepository;
let dbWrite: typeof import("../client").dbWrite;
let users: typeof import("../schemas/users").users;

function futureDate(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

async function seedUser(stewardUserId: string): Promise<string> {
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: stewardUserId, email: `${stewardUserId}@example.com` })
    .returning();
  return user.id;
}

function codeRow(userId: string, codeHash: string, expiresAt: Date) {
  return {
    code_hash: codeHash,
    client_id: "elizahub-forgejo",
    user_id: userId,
    steward_user_id: "steward-1",
    redirect_uri: "https://hub.example/callback",
    scope: "openid email",
    nonce: "n-1",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    token_issued_at: new Date(),
    expires_at: expiresAt,
  };
}

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);

  const { pushSchema } = await import("../push-schema-for-tests");
  ({ dbWrite } = await import("../client"));
  ({ users } = await import("../schemas/users"));
  const { organizations } = await import("../schemas/organizations");

  // Only the tables migration 0189 depends on; the OIDC tables themselves come
  // from the committed SQL below, which is the point of this suite.
  const { apply } = await pushSchema({ users, organizations } as never, dbWrite as never);
  await apply();

  const { sql } = await import("drizzle-orm");
  const applyMigration = async (path: string): Promise<void> => {
    for (const statement of readFileSync(path, "utf8").split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await dbWrite.execute(sql.raw(trimmed));
    }
  };

  await applyMigration(MIGRATION_0189);
  await dbWrite.execute(
    sql`INSERT INTO "oidc_authorization_requests"
        ("request_hash", "client_id", "redirect_uri", "scope", "expires_at")
        VALUES (${LEGACY_REQUEST_HASH}, 'elizahub-forgejo', 'https://hub.example/callback',
                'openid', ${futureDate(600)})`,
  );
  await applyMigration(MIGRATION_0190);

  ({ oidcRepository: repository } = await import("./oidc"));
});

afterAll(async () => {
  const { closeDatabaseConnectionsForTests } = await import("../client");
  await closeDatabaseConnectionsForTests();
});

describe("authorization codes", () => {
  test("a row written by the repository round-trips through the migrated table", async () => {
    const userId = await seedUser("mig-roundtrip");
    const inserted = await repository.insertCode(codeRow(userId, "hash-roundtrip", futureDate(60)));

    expect(inserted.client_id).toBe("elizahub-forgejo");
    expect(inserted.user_id).toBe(userId);
    expect(inserted.scope).toBe("openid email");
    expect(inserted.nonce).toBe("n-1");
    expect(inserted.code_challenge_method).toBe("S256");
    // Defaulted by the migration, not by the insert.
    expect(inserted.created_at).toBeInstanceOf(Date);
  });

  test("claimCode destroys the row and returns it exactly once", async () => {
    const userId = await seedUser("mig-claim");
    await repository.insertCode(codeRow(userId, "hash-claim", futureDate(60)));

    expect(await repository.claimCode("hash-claim")).toBeDefined();
    expect(await repository.claimCode("hash-claim")).toBeUndefined();
  });

  test("RACE: four concurrent claims of one code produce exactly one winner", async () => {
    const userId = await seedUser("mig-race");
    await repository.insertCode(codeRow(userId, "hash-race", futureDate(60)));

    const results = await Promise.all([
      repository.claimCode("hash-race"),
      repository.claimCode("hash-race"),
      repository.claimCode("hash-race"),
      repository.claimCode("hash-race"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("an expired code is not claimable, and is purged", async () => {
    const userId = await seedUser("mig-expired");
    await repository.insertCode(codeRow(userId, "hash-expired", futureDate(-1)));

    expect(await repository.claimCode("hash-expired")).toBeUndefined();
    expect(await repository.purgeExpiredCodes()).toBeGreaterThanOrEqual(1);
  });

  test("a duplicate code hash is a loud violation, never a silent overwrite", async () => {
    const userId = await seedUser("mig-dupe");
    await repository.insertCode(codeRow(userId, "hash-dupe", futureDate(60)));
    await expect(
      repository.insertCode(codeRow(userId, "hash-dupe", futureDate(60))),
    ).rejects.toThrow();
  });

  test("deleting the user cascades the code away", async () => {
    const userId = await seedUser("mig-cascade");
    await repository.insertCode(codeRow(userId, "hash-cascade", futureDate(60)));

    const { eq } = await import("drizzle-orm");
    await dbWrite.delete(users).where(eq(users.id, userId));

    expect(await repository.claimCode("hash-cascade")).toBeUndefined();
  });
});

describe("parked authorization requests", () => {
  test("0190 applies over a populated table and discards the unbound rows", async () => {
    // The migration ran in `beforeAll` with a 0189-era row present. Reaching
    // this assertion at all proves the ADD COLUMN did not fail; the row being
    // gone proves an unbound request cannot survive into a schema whose
    // `/resume` leg trusts `binding_hash`.
    const { sql } = await import("drizzle-orm");
    const survivors = await dbWrite.execute(
      sql`SELECT "request_hash" FROM "oidc_authorization_requests"
          WHERE "request_hash" = ${LEGACY_REQUEST_HASH}`,
    );
    expect(survivors.rows).toHaveLength(0);
  });

  test("a parked request round-trips with its browser binding and is single use", async () => {
    await repository.insertRequest({
      request_hash: "req-1",
      client_id: "elizahub-forgejo",
      redirect_uri: "https://hub.example/callback",
      scope: "openid",
      state: "s-1",
      nonce: null,
      code_challenge: null,
      code_challenge_method: null,
      binding_hash: "b".repeat(64),
      expires_at: futureDate(600),
    });

    const claimed = await repository.claimRequest("req-1");
    expect(claimed?.state).toBe("s-1");
    expect(claimed?.binding_hash).toBe("b".repeat(64));
    expect(await repository.claimRequest("req-1")).toBeUndefined();
  });

  test("a request with no browser binding cannot be parked at all", async () => {
    // The column is NOT NULL in the migration, so an unbound request is a
    // write error rather than a row `/resume` would have to decide about.
    await expect(
      repository.insertRequest({
        request_hash: "req-unbound",
        client_id: "elizahub-forgejo",
        redirect_uri: "https://hub.example/callback",
        scope: "openid",
        expires_at: futureDate(600),
      } as never),
    ).rejects.toThrow();
  });

  test("an expired request is not resumable", async () => {
    await repository.insertRequest({
      request_hash: "req-expired",
      client_id: "elizahub-forgejo",
      redirect_uri: "https://hub.example/callback",
      scope: "openid",
      binding_hash: "c".repeat(64),
      expires_at: futureDate(-1),
    });
    expect(await repository.claimRequest("req-expired")).toBeUndefined();
    expect(await repository.purgeExpiredRequests()).toBeGreaterThanOrEqual(1);
  });
});

describe("username allocation", () => {
  test("the first caller wins the name and the row defaults to a human account", async () => {
    const userId = await seedUser("mig-username");
    const allocated = await repository.allocateUsername(userId, "ada");
    expect(allocated?.username).toBe("ada");
    expect(allocated?.account_kind).toBe("human");
    expect(allocated?.actor_id).toBeNull();
  });

  test("a taken name is refused for a different user", async () => {
    const other = await seedUser("mig-username-other");
    expect(await repository.allocateUsername(other, "ada")).toBeUndefined();
    expect(await repository.findProfile(other)).toBeUndefined();
  });

  test("a second allocation for the SAME user is a no-op, not an overwrite", async () => {
    const userId = await seedUser("mig-username-twice");
    await repository.allocateUsername(userId, "grace");
    expect(await repository.allocateUsername(userId, "grace-2")).toBeUndefined();
    expect((await repository.findProfileForWrite(userId))?.username).toBe("grace");
  });

  test("RACE: concurrent allocations for one user leave exactly one frozen name", async () => {
    const userId = await seedUser("mig-username-race");
    const results = await Promise.all([
      repository.allocateUsername(userId, "race-a"),
      repository.allocateUsername(userId, "race-b"),
      repository.allocateUsername(userId, "race-c"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const frozen = await repository.findProfileForWrite(userId);
    expect(frozen).toBeDefined();
    expect(["race-a", "race-b", "race-c"]).toContain(frozen?.username as string);
  });
});
