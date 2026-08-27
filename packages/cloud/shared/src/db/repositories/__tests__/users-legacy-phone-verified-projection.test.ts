/**
 * Legacy phoneless user_identities.phone_verified NULL vs users.phone_verified
 * false must not block otherwise coherent phone/Telegram convergence, and
 * append-only repair must not restore healthy returning-login writes.
 *
 * Isolated PGlite only; no ambient Postgres and no live account mutation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { agentSandboxes } from "../../schemas/agent-sandboxes";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { personalAccountConvergences } from "../../schemas/personal-account-convergences";
import { personalDedicatedUpgradeAuthorities } from "../../schemas/personal-dedicated-upgrade-authorities";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../../schemas/personal-shared-groups";
import { userCharacters } from "../../schemas/user-characters";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { findReusablePersonalDelivery } from "../personal-shared-deliveries";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("legacy phoneless phone_verified projection (#28646)", () => {
  let pgliteReady = true;
  let sequence = 0;

  const createPair = async () => {
    sequence += 1;
    const phoneNumber = `+14155554${String(sequence).padStart(4, "0")}`;
    const telegramId = `30000${sequence}`;
    const phone = await usersRepository.findOrCreatePhonePersonalAccount({
      phoneNumber,
      displayName: `Phone ${sequence}`,
      organizationName: `Phone ${sequence}`,
      organizationSlug: `phone-legacy-${sequence}`,
    });
    const telegram = await usersRepository.findOrCreateMessagingPersonalAccount({
      platform: "telegram",
      telegramId,
      telegramUsername: `telegram_legacy_${sequence}`,
      telegramFirstName: `Telegram ${sequence}`,
      displayName: `Telegram ${sequence}`,
      organizationName: `Telegram ${sequence}`,
      organizationSlug: `telegram-legacy-${sequence}`,
    });
    return { phoneNumber, telegramId, phone, telegram };
  };

  const proofFor = (pair: Awaited<ReturnType<typeof createPair>>) => ({
    phoneNumber: pair.phoneNumber,
    telegramId: pair.telegramId,
    stewardUserId: `steward-legacy-${sequence}`,
    expectedTelegramUserId: pair.telegram.user.id,
    expectedTelegramOrganizationId: pair.telegram.organization.id,
  });

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-legacy-phone-verified-projection.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
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
          personalAccountConvergences,
          personalSharedGroupBindings,
          personalSharedGroupParticipants,
          personalSharedGroupJoinChallenges,
          userCharacters,
          agentSandboxes,
          personalDedicatedUpgradeAuthorities,
        } as never,
        dbWrite as never,
      );
      await apply();
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS credit_transactions (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS api_keys (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS conversations (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL
        )
      `);
      await dbWrite.execute(sql`
        ALTER TABLE "user_identities"
          DROP CONSTRAINT IF EXISTS "user_identities_phone_verified_requires_number"
      `);
      await dbWrite.execute(sql`
        ALTER TABLE "user_identities"
          ADD CONSTRAINT "user_identities_phone_verified_requires_number"
          CHECK ("phone_verified" IS NOT TRUE OR "phone_number" IS NOT NULL)
      `);
      await dbWrite.execute(sql`
        ALTER TABLE "users"
          DROP CONSTRAINT IF EXISTS "users_phone_verified_requires_number"
      `);
      await dbWrite.execute(sql`
        ALTER TABLE "users"
          ADD CONSTRAINT "users_phone_verified_requires_number"
          CHECK ("phone_verified" IS NOT TRUE OR "phone_number" IS NOT NULL)
      `);
    } catch (error) {
      pgliteReady = false;
      console.error(
        "[users-legacy-phone-verified-projection.test] PGlite schema setup failed.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(personalDedicatedUpgradeAuthorities);
    await dbWrite.delete(agentSandboxes);
    await dbWrite.delete(personalAccountConvergences);
    await dbWrite.delete(userIdentities);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("phoneless telegram false/NULL projection remains eligible for phone convergence", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const [telegramUser] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, pair.telegram.user.id));
    expect(telegramUser.phone_number).toBeNull();
    expect(telegramUser.phone_verified).toBe(false);

    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));

    const inspection = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(inspection.status).toBe("eligible");
  });

  test("phone routing stays fail-closed unless both rows are the same number and TRUE", async () => {
    const pair = await createPair();

    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));

    expect(
      await findReusablePersonalDelivery({
        platform: "phone",
        phoneNumber: pair.phoneNumber,
      }),
    ).toMatchObject({
      userId: pair.phone.user.id,
      organizationId: pair.phone.organization.id,
    });

    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, pair.phone.user.id));

    expect(
      await findReusablePersonalDelivery({
        platform: "phone",
        phoneNumber: pair.phoneNumber,
      }),
    ).toBeNull();
  });

  test("repairs phoneless false/NULL and is a no-write on healthy rows", async () => {
    const pair = await createPair();
    const telegramUserId = pair.telegram.user.id;
    const stewardUserId = pair.telegram.user.steward_user_id;

    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, telegramUserId));

    expect(
      await usersRepository.normalizePhonelessLegacyPhoneVerified({
        userId: telegramUserId,
        stewardUserId,
      }),
    ).toBe("repaired");
    const [repaired] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, telegramUserId));
    expect(repaired.phone_verified).toBe(false);
    expect(repaired.phone_number).toBeNull();

    const updatedAt = repaired.updated_at;
    expect(
      await usersRepository.normalizePhonelessLegacyPhoneVerified({
        userId: telegramUserId,
        stewardUserId,
      }),
    ).toBe("healthy");
    const [healthy] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, telegramUserId));
    expect(healthy.phone_verified).toBe(false);
    expect(healthy.updated_at).toEqual(updatedAt);
  });

  test("never claims or overwrites an identity owned by another user", async () => {
    const pair = await createPair();
    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));

    expect(
      await usersRepository.normalizePhonelessLegacyPhoneVerified({
        userId: pair.telegram.user.id,
        stewardUserId: pair.phone.user.steward_user_id,
      }),
    ).toBe("skipped");
    expect(
      await usersRepository.normalizePhonelessLegacyPhoneVerified({
        userId: pair.phone.user.id,
        stewardUserId: pair.telegram.user.steward_user_id,
      }),
    ).toBe("skipped");

    const [telegramProjection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    const [phoneProjection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, pair.phone.user.id));
    expect(telegramProjection.phone_verified).toBeNull();
    expect(phoneProjection.phone_verified).toBe(true);
    expect(phoneProjection.phone_number).toBe(pair.phoneNumber);
  });

  test("matching Steward authority still returns the canonical user when projection parity is only false/NULL", async () => {
    const pair = await createPair();
    await dbWrite
      .update(userIdentities)
      .set({ phone_verified: null })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));

    await expect(
      usersRepository.findPendingPhoneTelegramPersonalAccountConvergence({
        stewardUserId: pair.telegram.user.steward_user_id,
      }),
    ).resolves.toMatchObject({
      status: "canonical_user",
      user: { id: pair.telegram.user.id },
    });
  });

  test("new identity rows default phone_verified false and reject TRUE without a number", async () => {
    const pair = await createPair();
    const [fresh] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    expect(fresh.phone_number).toBeNull();
    expect(fresh.phone_verified).toBe(false);

    let rejected = false;
    try {
      await dbWrite
        .update(userIdentities)
        .set({ phone_verified: true })
        .where(eq(userIdentities.user_id, pair.telegram.user.id))
        .returning();
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
