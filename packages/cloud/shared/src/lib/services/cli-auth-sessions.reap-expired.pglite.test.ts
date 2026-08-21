/**
 * Expired CLI auth session reaping against real PGlite DDL (#22551).
 *
 * An abandoned sign-in leaves an `authenticated` session with
 * `consumed_at = NULL` and an active api_keys row whose plaintext was never
 * revealed. The sweep must revoke that orphan credential in the same
 * transaction that deletes the session, must NOT touch keys whose sessions
 * were consumed (those belong to a real CLI), and must invalidate the auth
 * caches for every revoked hash after commit. The repository and service under
 * test are real; only the cache invalidation boundary is spied.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { cliAuthSessionsRepository } from "../../db/repositories/cli-auth-sessions";
import { apiKeys } from "../../db/schemas/api-keys";
import { cliAuthSessions } from "../../db/schemas/cli-auth-sessions";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { apiKeysService } from "./api-keys";
import { cliAuthSessionsService } from "./cli-auth-sessions";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;
let seq = 0;

function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(spy: T): T {
  spies.push(spy);
  return spy;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = { organizations, users, apiKeys, cliAuthSessions };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(cliAuthSessions);
  await dbWrite.delete(apiKeys);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterEach(() => {
  while (spies.length > 0) spies.pop()?.mockRestore();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

async function seedIdentity(): Promise<{ orgId: string; userId: string }> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Reap Org", slug: uniq("reap-org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("reap-user"), organization_id: org.id })
    .returning();
  return { orgId: org.id, userId: user.id };
}

async function seedKey(
  ids: { orgId: string; userId: string },
  overrides: Partial<typeof apiKeys.$inferInsert> = {},
): Promise<{ id: string; key_hash: string }> {
  const hash = uniq("hash").padEnd(64, "0");
  const [key] = await dbWrite
    .insert(apiKeys)
    .values({
      name: uniq("CLI Login"),
      key_hash: hash,
      key_prefix: "eliza_te",
      organization_id: ids.orgId,
      user_id: ids.userId,
      is_active: true,
      ...overrides,
    })
    .returning({ id: apiKeys.id, key_hash: apiKeys.key_hash });
  return key;
}

async function seedSession(overrides: Partial<typeof cliAuthSessions.$inferInsert>): Promise<void> {
  await dbWrite.insert(cliAuthSessions).values({
    session_id: uniq("sess"),
    status: "pending",
    expires_at: new Date(Date.now() - 60_000),
    ...overrides,
  });
}

async function keyIsActive(id: string): Promise<boolean> {
  const [row] = await dbWrite
    .select({ is_active: apiKeys.is_active })
    .from(apiKeys)
    .where(eq(apiKeys.id, id));
  return row.is_active;
}

describe("reapExpiredSessions on primary PGlite", () => {
  test("revokes the orphan key of an expired, never-consumed authenticated session", async () => {
    const ids = await seedIdentity();
    const orphan = await seedKey(ids);
    await seedSession({
      status: "authenticated",
      user_id: ids.userId,
      api_key_id: orphan.id,
      consumed_at: null,
      authenticated_at: new Date(Date.now() - 120_000),
    });

    const result = await cliAuthSessionsRepository.reapExpiredSessions();

    expect(result.deletedSessions).toBe(1);
    expect(result.revokedOrphanKeys).toEqual([{ id: orphan.id, key_hash: orphan.key_hash }]);
    expect(await keyIsActive(orphan.id)).toBe(false);
    expect(await dbWrite.select().from(cliAuthSessions)).toHaveLength(0);
  });

  test("leaves a consumed session's key active while deleting the session", async () => {
    const ids = await seedIdentity();
    const delivered = await seedKey(ids);
    await seedSession({
      status: "authenticated",
      user_id: ids.userId,
      api_key_id: delivered.id,
      consumed_at: new Date(Date.now() - 90_000),
    });

    const result = await cliAuthSessionsRepository.reapExpiredSessions();

    expect(result.deletedSessions).toBe(1);
    expect(result.revokedOrphanKeys).toEqual([]);
    expect(await keyIsActive(delivered.id)).toBe(true);
  });

  test("ignores live sessions and keyless expired sessions", async () => {
    const ids = await seedIdentity();
    const liveKey = await seedKey(ids);
    await seedSession({
      status: "authenticated",
      user_id: ids.userId,
      api_key_id: liveKey.id,
      expires_at: new Date(Date.now() + 600_000),
    });
    await seedSession({ status: "pending", api_key_id: null });

    const result = await cliAuthSessionsRepository.reapExpiredSessions();

    expect(result.deletedSessions).toBe(1);
    expect(result.revokedOrphanKeys).toEqual([]);
    expect(await keyIsActive(liveKey.id)).toBe(true);
    expect(await dbWrite.select().from(cliAuthSessions)).toHaveLength(1);
  });

  test("does not re-report keys already revoked or soft-deleted", async () => {
    const ids = await seedIdentity();
    const alreadyRevoked = await seedKey(ids, { is_active: false });
    const softDeleted = await seedKey(ids, { deleted_at: new Date() });
    await seedSession({
      status: "authenticated",
      user_id: ids.userId,
      api_key_id: alreadyRevoked.id,
    });
    await seedSession({ status: "authenticated", user_id: ids.userId, api_key_id: softDeleted.id });

    const result = await cliAuthSessionsRepository.reapExpiredSessions();

    expect(result.deletedSessions).toBe(2);
    expect(result.revokedOrphanKeys).toEqual([]);
  });
});

describe("cleanupExpiredSessions service boundary", () => {
  test("invalidates auth caches for each revoked orphan hash after commit", async () => {
    const ids = await seedIdentity();
    const orphanA = await seedKey(ids);
    const orphanB = await seedKey(ids);
    await seedSession({ status: "authenticated", user_id: ids.userId, api_key_id: orphanA.id });
    await seedSession({ status: "authenticated", user_id: ids.userId, api_key_id: orphanB.id });

    const invalidate = track(spyOn(apiKeysService, "invalidateCache").mockResolvedValue(undefined));

    const result = await cliAuthSessionsService.cleanupExpiredSessions();

    expect(result).toEqual({ deletedSessions: 2, revokedOrphanKeys: 2 });
    const invalidatedHashes = invalidate.mock.calls.map((call) => call[0]).sort();
    expect(invalidatedHashes).toEqual([orphanA.key_hash, orphanB.key_hash].sort());
    // Both keys were already inactive in the database before any invalidation
    // ran (write-then-invalidate): re-check the durable state.
    expect(await keyIsActive(orphanA.id)).toBe(false);
    expect(await keyIsActive(orphanB.id)).toBe(false);
  });

  test("surfaces an unconfirmed cache invalidation instead of swallowing it", async () => {
    const ids = await seedIdentity();
    const orphan = await seedKey(ids);
    await seedSession({ status: "authenticated", user_id: ids.userId, api_key_id: orphan.id });

    track(
      spyOn(apiKeysService, "invalidateCache").mockRejectedValue(
        new Error("cache invalidation not confirmed"),
      ),
    );

    await expect(cliAuthSessionsService.cleanupExpiredSessions()).rejects.toThrow(
      "cache invalidation not confirmed",
    );
    // The durable revocation still committed: the key denies from the database.
    expect(await keyIsActive(orphan.id)).toBe(false);
  });
});
