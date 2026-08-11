/**
 * Exercises Telegram-plus-phone identity linking against the real Drizzle
 * schema on isolated PGlite, including fresh projection lookups and rollback
 * when a stale projection owns an otherwise-free canonical identity.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../client";
import { organizationBalanceRevisionSequence, organizations } from "../schemas/organizations";
import { userIdentities } from "../schemas/user-identities";
import { users } from "../schemas/users";
import { usersRepository } from "./users";

const PGLITE_TIMEOUT = 60_000;
const USER_A = "00000000-0000-4000-8000-000000000101";
const USER_B = "00000000-0000-4000-8000-000000000102";
const USER_C = "00000000-0000-4000-8000-000000000103";
let pgliteReady = true;

async function seedUser(
  userId: string,
  stewardUserId: string,
  includeProjection = true,
): Promise<void> {
  await dbWrite.insert(users).values({ id: userId, steward_user_id: stewardUserId });
  if (!includeProjection) {
    return;
  }
  await dbWrite.insert(userIdentities).values({
    user_id: userId,
    steward_user_id: stewardUserId,
  });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[users-identity-link.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
    );
    return;
  }

  try {
    const { apply } = await pushSchema(
      {
        organizationBalanceRevisionSequence,
        organizations,
        users,
        userIdentities,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and every case fails loudly.
    pgliteReady = false;
    console.error("[users-identity-link.integration.test] PGlite schema setup failed.", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(userIdentities);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("UsersRepository.linkTelegramAndPhoneIdentity", () => {
  test("commits the canonical row and lookup projection together", async () => {
    await seedUser(USER_A, "steward-user-a");

    const linked = await usersRepository.linkTelegramAndPhoneIdentity(USER_A, {
      telegram_id: "123456789",
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: "+14155550123",
    });

    expect(linked.status).toBe("linked");
    const linkedUser = linked.status === "linked" ? linked.user : undefined;
    expect(linkedUser?.telegram_id).toBe("123456789");
    expect(linkedUser?.phone_number).toBe("+14155550123");
    expect(linkedUser?.phone_verified).toBe(true);

    const byTelegram = await usersRepository.findByTelegramIdWithOrganization("123456789");
    const byPhone = await usersRepository.findByPhoneNumberWithOrganization("+14155550123");
    expect(byTelegram?.id).toBe(USER_A);
    expect(byPhone?.id).toBe(USER_A);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    expect(projection).toMatchObject({
      telegram_id: "123456789",
      telegram_username: "sam",
      phone_number: "+14155550123",
      phone_verified: true,
    });
  });

  test("rolls the canonical write back when the projection conflicts", async () => {
    await seedUser(USER_A, "steward-user-a");
    await seedUser(USER_B, "steward-user-b");
    await dbWrite
      .update(userIdentities)
      .set({ telegram_id: "987654321" })
      .where(eq(userIdentities.user_id, USER_B));

    await expect(
      usersRepository.linkTelegramAndPhoneIdentity(USER_A, {
        telegram_id: "987654321",
        phone_number: "+14155550999",
      }),
    ).rejects.toThrow();

    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, USER_A));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    expect(canonical).toMatchObject({
      telegram_id: null,
      phone_number: null,
      phone_verified: false,
    });
    expect(projection).toMatchObject({
      telegram_id: null,
      phone_number: null,
      phone_verified: false,
    });
  });

  test("creates a missing projection instead of relying on fallback reads", async () => {
    await seedUser(USER_C, "steward-user-c", false);

    const linked = await usersRepository.linkTelegramAndPhoneIdentity(USER_C, {
      telegram_id: "555555555",
      phone_number: "+14155550555",
    });
    expect(linked.status).toBe("linked");

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_C));
    expect(projection).toMatchObject({
      steward_user_id: "steward-user-c",
      telegram_id: "555555555",
      phone_number: "+14155550555",
      phone_verified: true,
    });
    expect((await usersRepository.findByTelegramId("555555555"))?.id).toBe(USER_C);
    expect((await usersRepository.findByPhoneNumber("+14155550555"))?.id).toBe(USER_C);
  });
});

describe("UsersRepository.linkDiscordIdentity", () => {
  test("rolls back the canonical write when another projection owns the Discord id", async () => {
    await seedUser(USER_A, "steward-user-a");
    await seedUser(USER_B, "steward-user-b");
    await dbWrite
      .update(userIdentities)
      .set({ discord_id: "atomic-conflict" })
      .where(eq(userIdentities.user_id, USER_B));

    await expect(
      usersRepository.linkDiscordIdentity(USER_A, {
        discord_id: "atomic-conflict",
        discord_username: "attacker",
      }),
    ).rejects.toBeDefined();

    const [canonical] = await dbWrite
      .select({ discord_id: users.discord_id })
      .from(users)
      .where(eq(users.id, USER_A));
    expect(canonical?.discord_id).toBeNull();
  });

  test("concurrent claims cannot split canonical and projection ownership", async () => {
    await seedUser(USER_A, "steward-user-a");
    await seedUser(USER_B, "steward-user-b");
    const identity = {
      discord_id: "atomic-race",
      discord_username: "racer",
    };
    const results = await Promise.allSettled([
      usersRepository.linkDiscordIdentity(USER_A, identity),
      usersRepository.linkDiscordIdentity(USER_B, identity),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    const canonicalOwners = await dbWrite
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discord_id, identity.discord_id));
    const projectionOwners = await dbWrite
      .select({ user_id: userIdentities.user_id })
      .from(userIdentities)
      .where(eq(userIdentities.discord_id, identity.discord_id));
    expect(canonicalOwners).toHaveLength(1);
    expect(projectionOwners).toHaveLength(1);
    expect(projectionOwners[0]?.user_id).toBe(canonicalOwners[0]?.id);
  });
});

describe("UsersRepository.refreshDiscordProjectionForWrite", () => {
  test("projects a canonical Discord link into the identity row Discord routing reads", async () => {
    await seedUser(USER_A, "steward-user-a");
    await usersRepository.update(USER_A, {
      discord_id: "111100001111",
      discord_username: "sam",
      discord_global_name: "Sam",
      discord_avatar_url: "https://cdn.example/avatar.png",
    });
    // Canonical-only write: routing cannot see it yet.
    expect(await usersRepository.findByDiscordIdWithOrganization("111100001111")).toBeUndefined();

    await usersRepository.refreshDiscordProjectionForWrite(USER_A);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    expect(projection).toMatchObject({
      discord_id: "111100001111",
      discord_username: "sam",
      discord_global_name: "Sam",
      discord_avatar_url: "https://cdn.example/avatar.png",
    });
    expect((await usersRepository.findByDiscordId("111100001111"))?.id).toBe(USER_A);
  });

  test("creates a missing projection row instead of silently skipping the user", async () => {
    await seedUser(USER_C, "steward-user-c", false);
    await usersRepository.update(USER_C, {
      discord_id: "333300003333",
      discord_username: "casey",
    });

    await usersRepository.refreshDiscordProjectionForWrite(USER_C);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_C));
    expect(projection).toMatchObject({
      steward_user_id: "steward-user-c",
      discord_id: "333300003333",
      discord_username: "casey",
    });
    expect((await usersRepository.findByDiscordId("333300003333"))?.id).toBe(USER_C);
  });

  test("declines the refresh when another user's projection owns the discord id", async () => {
    await seedUser(USER_A, "steward-user-a");
    await seedUser(USER_B, "steward-user-b");
    await dbWrite
      .update(userIdentities)
      .set({ discord_id: "222200002222" })
      .where(eq(userIdentities.user_id, USER_B));
    // Canonical row on USER_A claims the same discord id (e.g. a raced legacy
    // write); the projection refresh must not steal it from USER_B.
    await dbWrite.update(users).set({ discord_id: null }).where(eq(users.id, USER_B));
    await usersRepository.update(USER_A, { discord_id: "222200002222" });

    await usersRepository.refreshDiscordProjectionForWrite(USER_A);

    const [projectionA] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    const [projectionB] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_B));
    expect(projectionA?.discord_id).toBeNull();
    expect(projectionB?.discord_id).toBe("222200002222");
    expect((await usersRepository.findByDiscordId("222200002222"))?.id).toBe(USER_B);
  });

  test("clears stale projection fields when the canonical link was removed", async () => {
    await seedUser(USER_A, "steward-user-a");
    await dbWrite
      .update(userIdentities)
      .set({ discord_id: "444400004444", discord_username: "stale" })
      .where(eq(userIdentities.user_id, USER_A));

    await usersRepository.refreshDiscordProjectionForWrite(USER_A);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    expect(projection?.discord_id).toBeNull();
    expect(projection?.discord_username).toBeNull();
  });
});

describe("UsersRepository.findByCanonicalDiscordIdWithOrganization", () => {
  test("finds a canonical-only legacy link the projection lookup misses", async () => {
    await seedUser(USER_A, "steward-user-a");
    await usersRepository.update(USER_A, { discord_id: "555500005555" });

    expect(await usersRepository.findByDiscordIdWithOrganization("555500005555")).toBeUndefined();
    const canonical =
      await usersRepository.findByCanonicalDiscordIdWithOrganization("555500005555");
    expect(canonical?.id).toBe(USER_A);
  });
});
