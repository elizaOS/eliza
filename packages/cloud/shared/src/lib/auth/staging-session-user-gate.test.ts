/**
 * `loadVerifiedStagingSessionUser` is the identity half of the staging-only
 * API-key-to-browser-session bridge: a ten-clause fail-closed disjunction that
 * must return `null` unless the user, the organization and the Steward
 * projection all still agree with the signed binding.
 *
 * Every clause is asserted on its own. A single happy path plus a single
 * rejection would leave eight of them free to be deleted silently, and each
 * one is a distinct way for a revoked or expired subject to keep a session.
 *
 * The harness is real: the actual repository query runs against in-process
 * PGlite with the production Drizzle DDL applied by `pushSchemaToTestDb`. The
 * trailing loud guard fails the suite if PGlite never initialized, so the
 * database cases can never pass vacuously.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const TIMEOUT = 120_000;
const ORG_ID = "00000000-0000-4000-8000-0000000004a1";
const OTHER_ORG_ID = "00000000-0000-4000-8000-0000000004a2";
const STEWARD_USER_ID = "steward-staging-subject";

let dbWrite: typeof import("../../db/client").dbWrite;
let closeDb: typeof import("../../db/client").closeDatabaseConnectionsForTests | undefined;
let loadVerifiedStagingSessionUser: typeof import("./staging-session-binding").loadVerifiedStagingSessionUser;
let users: typeof import("../../db/schemas/users").users;
let pgliteReady = true;
let seq = 0;

type UserOverrides = {
  is_active?: boolean;
  is_anonymous?: boolean;
  deleted_at?: Date | null;
  expires_at?: Date | null;
  organization_id?: string | null;
  steward_user_id?: string;
};

/** Inserts one user in ORG_ID with the documented-good shape, then applies overrides. */
async function seedUser(overrides: UserOverrides = {}): Promise<string> {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await dbWrite.insert(users).values({
    id,
    organization_id: ORG_ID,
    steward_user_id: `${STEWARD_USER_ID}-${seq}`,
    is_active: true,
    is_anonymous: false,
    deleted_at: null,
    expires_at: null,
    ...overrides,
  } as never);
  return id;
}

function bindingFor(userId: string, organizationId = ORG_ID) {
  return {
    version: "v1" as const,
    apiKeyId: "00000000-0000-4000-8000-0000000004ff",
    cloudUserId: userId,
    organizationId,
    credentialFingerprint: "f".repeat(64),
    sessionIssuedAt: 0,
    sessionMaxExpiresAt: 0,
  };
}

function stewardIdFor(userId: string): string {
  return `${STEWARD_USER_ID}-${userId.slice(-12).replace(/^0+/, "")}`;
}

async function load(
  userId: string,
  options?: { stewardUserId?: string; now?: Date; org?: string },
) {
  return await loadVerifiedStagingSessionUser({
    binding: bindingFor(userId, options?.org),
    stewardUserId: options?.stewardUserId ?? stewardIdFor(userId),
    now: options?.now,
  });
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../db/client"));
    const { pushSchemaToTestDb } = await import("../../db/push-schema-for-tests");
    const { organizations } = await import("../../db/schemas/organizations");
    ({ users } = await import("../../db/schemas/users"));
    await pushSchemaToTestDb({ users, organizations });
    await dbWrite.insert(organizations).values([
      { id: ORG_ID, name: "staging-org", slug: "staging-org", is_active: true },
      { id: OTHER_ORG_ID, name: "other-org", slug: "other-org", is_active: true },
    ] as never);
    ({ loadVerifiedStagingSessionUser } = await import("./staging-session-binding"));
  } catch (error) {
    pgliteReady = false;
    console.warn("[staging-session-user-gate] PGlite unavailable:", error);
  }
}, TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

test(
  "accepts a user whose row, organization and Steward id all match the binding",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser();
    const user = await load(id);
    expect(user).not.toBeNull();
    expect(user?.id).toBe(id);
    expect(user?.organization?.id).toBe(ORG_ID);
  },
  TIMEOUT,
);

test(
  "rejects a cloudUserId that has no row at all",
  async () => {
    if (!pgliteReady) return;
    expect(
      await loadVerifiedStagingSessionUser({
        binding: bindingFor("00000000-0000-4000-8000-0000000004fe"),
        stewardUserId: STEWARD_USER_ID,
      }),
    ).toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a deactivated user",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser({ is_active: false });
    expect(await load(id)).toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects an anonymous user",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser({ is_anonymous: true });
    expect(await load(id)).toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a soft-deleted user",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser({ deleted_at: new Date("2020-01-01T00:00:00.000Z") });
    expect(await load(id)).toBeNull();
  },
  TIMEOUT,
);

test(
  "expiry is inclusive at the boundary and open in both directions",
  async () => {
    if (!pgliteReady) return;
    const at = new Date("2030-01-01T00:00:00.000Z");
    const id = await seedUser({ expires_at: at });

    // `<= now` — an expiry exactly at `now` is already spent.
    expect(await load(id, { now: at })).toBeNull();
    expect(await load(id, { now: new Date(at.getTime() + 1) })).toBeNull();
    expect(await load(id, { now: new Date(at.getTime() - 1) })).not.toBeNull();

    // A null expiry never expires, whatever `now` is.
    const immortal = await seedUser({ expires_at: null });
    expect(await load(immortal, { now: new Date("2999-01-01T00:00:00.000Z") })).not.toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a user whose organization is not the one in the binding",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser({ organization_id: OTHER_ORG_ID });
    expect(await load(id)).toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a user with no organization at all",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser({ organization_id: null });
    expect(await load(id)).toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a user in a deactivated organization",
  async () => {
    if (!pgliteReady) return;
    const { organizations } = await import("../../db/schemas/organizations");
    const { eq } = await import("drizzle-orm");
    const deadOrg = "00000000-0000-4000-8000-0000000004b9";
    await dbWrite
      .insert(organizations)
      .values([{ id: deadOrg, name: "dead-org", slug: "dead-org", is_active: false }] as never);
    const id = await seedUser({ organization_id: deadOrg });

    expect(await load(id, { org: deadOrg })).toBeNull();

    // Reactivating the same organization is the only thing that changes, so the
    // rejection above is attributable to `organization.is_active` alone.
    await dbWrite
      .update(organizations)
      .set({ is_active: true })
      .where(eq(organizations.id, deadOrg));
    expect(await load(id, { org: deadOrg })).not.toBeNull();
  },
  TIMEOUT,
);

test(
  "rejects a Steward id that does not match, and compares it trimmed",
  async () => {
    if (!pgliteReady) return;
    const id = await seedUser();
    const expected = stewardIdFor(id);

    expect(await load(id, { stewardUserId: `${expected}-other` })).toBeNull();
    expect(await load(id, { stewardUserId: expected.toUpperCase() })).toBeNull();
    expect(await load(id, { stewardUserId: "" })).toBeNull();
    // The stored value is trimmed before comparison; the supplied one is not.
    expect(await load(id, { stewardUserId: ` ${expected} ` })).toBeNull();

    const paddedSteward = "padded-steward-subject";
    const padded = await seedUser({ steward_user_id: `  ${paddedSteward}  ` });
    expect(await load(padded, { stewardUserId: paddedSteward })).not.toBeNull();
  },
  TIMEOUT,
);

test(
  "defaults `now` to the current time when the caller omits it",
  async () => {
    if (!pgliteReady) return;
    const past = await seedUser({ expires_at: new Date(Date.now() - 60_000) });
    const future = await seedUser({ expires_at: new Date(Date.now() + 60_000) });
    expect(await load(past)).toBeNull();
    expect(await load(future)).not.toBeNull();
  },
  TIMEOUT,
);

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// Without this a broken import or failed schema push would skip every case
// above and the suite would pass vacuously.
test("PGlite harness initialized (DB cases above are not vacuous)", () => {
  expect(pgliteReady).toBe(true);
});
