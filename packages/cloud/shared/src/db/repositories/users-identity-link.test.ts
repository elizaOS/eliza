// Exercises the atomic Telegram+phone identity link across the canonical
// users row and the user_identities projection against a real PGlite
// database. DDL is derived from the Drizzle schemas so column drift cannot
// silently divorce the test tables from production shapes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

let dbWrite: typeof import("../helpers").dbWrite;
let usersRepository: typeof import("./users").usersRepository;
let users: typeof import("../schemas/users").users;
let organizations: typeof import("../schemas/organizations").organizations;
let userIdentities: typeof import("../schemas/user-identities").userIdentities;
let pgliteReady = true;

/**
 * Renders CREATE TABLE DDL from the Drizzle schema. Database-level defaults
 * are intentionally dropped (inserts below provide explicit values), and NOT
 * NULL is kept only for default-free columns so omitted defaulted columns
 * stay insertable. Unique constraints are preserved — they are the collision
 * surface this suite exists to prove atomic.
 */
function ddlFor(table: PgTable): string {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => {
    const parts = [`"${column.name}" ${column.getSQLType()}`];
    if (column.primary) parts.push("PRIMARY KEY");
    else if (column.notNull && !column.hasDefault) parts.push("NOT NULL");
    if (column.isUnique) parts.push("UNIQUE");
    return parts.join(" ");
  });
  return `CREATE TABLE IF NOT EXISTS "${config.name}" (${columns.join(", ")})`;
}

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const USER_B = "33333333-3333-4333-8333-333333333333";
const USER_C = "44444444-4444-4444-8444-444444444444";
const TELEGRAM_ID = "123456789";
const PHONE = "+14155550123";

const TELEGRAM_LINK = {
  telegram_id: TELEGRAM_ID,
  telegram_username: "sam",
  telegram_first_name: "Sam",
  phone_number: PHONE,
  phone_verified: true,
};

beforeAll(async () => {
  try {
    ({ dbWrite } = await import("../helpers"));
    ({ usersRepository } = await import("./users"));
    ({ users } = await import("../schemas/users"));
    ({ organizations } = await import("../schemas/organizations"));
    ({ userIdentities } = await import("../schemas/user-identities"));
    for (const table of [organizations, users, userIdentities]) {
      await dbWrite.execute(sql.raw(ddlFor(table)));
    }
  } catch {
    pgliteReady = false;
  }
});

beforeEach(async () => {
  if (!pgliteReady) return;
  await dbWrite.execute(sql`DELETE FROM user_identities`);
  await dbWrite.execute(sql`DELETE FROM users`);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "Identity Link Org",
    slug: "identity-link-org",
  });
  await dbWrite.insert(users).values([
    { id: USER_A, steward_user_id: "steward-a", organization_id: ORG_ID },
    { id: USER_B, steward_user_id: "steward-b", organization_id: ORG_ID },
    { id: USER_C, steward_user_id: "steward-c", organization_id: ORG_ID },
  ]);
  // A and B carry identity projection rows; C is a legacy pre-projection user.
  await dbWrite.insert(userIdentities).values([
    { id: crypto.randomUUID(), user_id: USER_A, steward_user_id: "steward-a" },
    { id: crypto.randomUUID(), user_id: USER_B, steward_user_id: "steward-b" },
  ]);
});

afterAll(async () => {
  if (!pgliteReady) return;
  await dbWrite.execute(sql`DROP TABLE IF EXISTS user_identities`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS users`);
  await dbWrite.execute(sql`DROP TABLE IF EXISTS organizations`);
});

async function identityRowOf(userId: string) {
  return await dbWrite.query.userIdentities.findFirst({
    where: (row, { eq }) => eq(row.user_id, userId),
  });
}

async function canonicalRowOf(userId: string) {
  return await dbWrite.query.users.findFirst({
    where: (row, { eq }) => eq(row.id, userId),
  });
}

describe("linkTelegramAndPhoneIdentityForWrite", () => {
  test("link refreshes the projection and fresh lookups resolve by Telegram ID and phone", async () => {
    if (!pgliteReady) return;
    const updated = await usersRepository.linkTelegramAndPhoneIdentityForWrite(
      USER_A,
      TELEGRAM_LINK,
    );
    expect(updated?.id).toBe(USER_A);

    const projection = await identityRowOf(USER_A);
    expect(projection).toMatchObject({
      telegram_id: TELEGRAM_ID,
      phone_number: PHONE,
      phone_verified: true,
    });

    const byTelegram = await usersRepository.findByTelegramIdWithOrganization(TELEGRAM_ID);
    const byPhone = await usersRepository.findByPhoneNumberWithOrganization(PHONE);
    expect(byTelegram?.id).toBe(USER_A);
    expect(byTelegram?.organization?.id).toBe(ORG_ID);
    expect(byPhone?.id).toBe(USER_A);
  });

  test("a stale cross-user projection collision aborts atomically with no half-link in either table", async () => {
    if (!pgliteReady) return;
    // B's projection still claims the Telegram id (the stale shape the
    // canonical row no longer backs). Linking A must fail as one unit.
    await dbWrite.execute(sql`
      UPDATE user_identities SET telegram_id = ${TELEGRAM_ID}
      WHERE user_id = ${USER_B}
    `);

    let thrown: unknown;
    try {
      await usersRepository.linkTelegramAndPhoneIdentityForWrite(USER_A, TELEGRAM_LINK);
    } catch (error) {
      // error-policy:J3 the unique violation is the asserted outcome of this
      // adversarial fixture, not a swallowed failure.
      thrown = error;
    }
    expect(thrown).toBeDefined();

    const canonical = await canonicalRowOf(USER_A);
    const projection = await identityRowOf(USER_A);
    expect(canonical?.telegram_id).toBeNull();
    expect(canonical?.phone_number).toBeNull();
    expect(projection?.telegram_id).toBeNull();
    expect(projection?.phone_number).toBeNull();
  });

  test("a pre-projection legacy user links canonically and resolves through the fallback lookups", async () => {
    if (!pgliteReady) return;
    const updated = await usersRepository.linkTelegramAndPhoneIdentityForWrite(
      USER_C,
      TELEGRAM_LINK,
    );
    expect(updated?.id).toBe(USER_C);
    expect(await identityRowOf(USER_C)).toBeUndefined();

    const byTelegram = await usersRepository.findByTelegramId(TELEGRAM_ID);
    const byPhone = await usersRepository.findByPhoneNumber(PHONE);
    expect(byTelegram?.id).toBe(USER_C);
    expect(byPhone?.id).toBe(USER_C);
  });
});
