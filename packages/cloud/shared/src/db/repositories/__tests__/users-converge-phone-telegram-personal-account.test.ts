/**
 * Exercises the explicitly proved phone + Telegram provisional-account merge
 * against real PGlite, including retry receipts and strict maturity guards.
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
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { personalAccountConvergences } from "../../schemas/personal-account-convergences";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository phone + Telegram provisional convergence (real PGlite)", () => {
  let pgliteReady = true;
  let sequence = 0;

  const createPair = async () => {
    sequence += 1;
    const phoneNumber = `+14155553${String(sequence).padStart(4, "0")}`;
    const telegramId = `20000${sequence}`;
    const phone = await usersRepository.findOrCreatePhonePersonalAccount({
      phoneNumber,
      displayName: `Phone ${sequence}`,
      organizationName: `Phone ${sequence}`,
      organizationSlug: `phone-convergence-${sequence}`,
    });
    const telegram = await usersRepository.findOrCreateTelegramPersonalAccount({
      telegramId,
      telegramUsername: `telegram_${sequence}`,
      telegramFirstName: `Telegram ${sequence}`,
      displayName: `Telegram ${sequence}`,
      organizationName: `Telegram ${sequence}`,
      organizationSlug: `telegram-convergence-${sequence}`,
    });
    return { phoneNumber, telegramId, phone, telegram };
  };

  const proofFor = (pair: Awaited<ReturnType<typeof createPair>>) => ({
    phoneNumber: pair.phoneNumber,
    telegramId: pair.telegramId,
    stewardUserId: `steward-convergence-${sequence}`,
    expectedTelegramUserId: pair.telegram.user.id,
    expectedTelegramOrganizationId: pair.telegram.organization.id,
  });

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-converge-phone-telegram-personal-account.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
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
        } as never,
        dbWrite as never,
      );
      await apply();
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS agent_sandboxes (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL,
          pool_status text,
          deleted_at timestamp
        )
      `);
      await dbWrite.execute(sql`
        CREATE TABLE IF NOT EXISTS user_characters (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL
        )
      `);
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
        CREATE TABLE IF NOT EXISTS user_sessions (
          id uuid PRIMARY KEY,
          organization_id uuid NOT NULL,
          user_id uuid NOT NULL
        )
      `);
    } catch (error) {
      // error-policy:J1 The test boundary records setup failure and every case fails loudly.
      pgliteReady = false;
      console.error(
        "[users-converge-phone-telegram-personal-account.test] PGlite schema setup failed.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    await dbWrite.execute(sql`DELETE FROM user_characters`);
    await dbWrite.execute(sql`DELETE FROM credit_transactions`);
    await dbWrite.execute(sql`DELETE FROM api_keys`);
    await dbWrite.execute(sql`DELETE FROM conversations`);
    await dbWrite.execute(sql`DELETE FROM user_sessions`);
    await dbWrite.delete(personalAccountConvergences);
    await dbWrite.delete(userIdentities);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("converges exactly two $0 provisional accounts and retains an idempotent alias receipt", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const inspection = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(inspection.status).toBe("eligible");
    if (inspection.status !== "eligible") return;

    const params = {
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:source",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:target",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    };
    const result = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(result.status).toBe("committed");
    if (result.status !== "committed") return;

    expect(result.user).toMatchObject({
      id: pair.telegram.user.id,
      organization_id: pair.telegram.organization.id,
      steward_user_id: proof.stewardUserId,
      telegram_id: pair.telegramId,
      phone_number: pair.phoneNumber,
      phone_verified: true,
    });
    expect(result.organization.credit_balance).toBe("0.000000");
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(1);

    const retry = await usersRepository.commitPhoneTelegramPersonalAccountConvergence(params);
    expect(retry.status).toBe("already_committed");
    const conflictingRetry = await usersRepository.commitPhoneTelegramPersonalAccountConvergence({
      ...params,
      targetAgentId: "personal:conflicting-target",
    });
    expect(conflictingRetry.status).toBe("continuation_account_mismatch");
    const resumed = await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof);
    expect(resumed.status).toBe("resume_alias");

    const completed = await usersRepository.markPhoneTelegramPersonalAccountAliasComplete(
      params.token,
    );
    expect(completed?.status).toBe("complete");
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    expect(projection).toMatchObject({
      steward_user_id: proof.stewardUserId,
      telegram_id: pair.telegramId,
      phone_number: pair.phoneNumber,
      phone_verified: true,
    });
  });

  test("serializes concurrent commit retries onto one canonical user and receipt", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    const params = {
      ...proof,
      sourceUserId: pair.phone.user.id,
      sourceOrganizationId: pair.phone.organization.id,
      sourceAgentId: "personal:source-concurrent",
      targetUserId: pair.telegram.user.id,
      targetOrganizationId: pair.telegram.organization.id,
      targetAgentId: "personal:target-concurrent",
      token: `phone-telegram:${pair.phone.user.id}:${pair.telegram.user.id}`,
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        usersRepository.commitPhoneTelegramPersonalAccountConvergence(params),
      ),
    );

    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_committed")).toHaveLength(5);
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(personalAccountConvergences)).toHaveLength(1);
  });

  test("rejects funded, agent-bearing, and mature provisional-shaped accounts", async () => {
    const funded = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO credit_transactions (id, organization_id)
          VALUES (${crypto.randomUUID()}, ${funded.phone.organization.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(funded)))
        .status,
    ).toBe("funded_account");

    await dbWrite.execute(sql`DELETE FROM credit_transactions`);
    const agentBearing = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO agent_sandboxes (id, organization_id, user_id)
          VALUES (${crypto.randomUUID()}, ${agentBearing.telegram.organization.id}, ${agentBearing.telegram.user.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(agentBearing)))
        .status,
    ).toBe("agent_bearing_account");

    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    const mature = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO api_keys (id, organization_id)
          VALUES (${crypto.randomUUID()}, ${mature.phone.organization.id})`,
    );
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(mature)))
        .status,
    ).toBe("phone_account_mature");

    const sessionBearing = await createPair();
    await dbWrite.execute(
      sql`INSERT INTO user_sessions (id, organization_id, user_id)
          VALUES (
            ${crypto.randomUUID()},
            ${sessionBearing.telegram.organization.id},
            ${sessionBearing.telegram.user.id}
          )`,
    );
    expect(
      (
        await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(
          proofFor(sessionBearing),
        )
      ).status,
    ).toBe("telegram_account_mature");

    const multiMember = await createPair();
    await dbWrite.insert(users).values({
      steward_user_id: `extra-member-${crypto.randomUUID()}`,
      organization_id: multiMember.phone.organization.id,
      role: "member",
      is_active: true,
    });
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proofFor(multiMember)))
        .status,
    ).toBe("phone_account_mature");
  });

  test("rejects a continuation or projection that does not own the Telegram target", async () => {
    const pair = await createPair();
    const proof = proofFor(pair);
    expect(
      (
        await usersRepository.inspectPhoneTelegramPersonalAccountConvergence({
          ...proof,
          expectedTelegramUserId: crypto.randomUUID(),
        })
      ).status,
    ).toBe("continuation_account_mismatch");

    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: "tampered-telegram-projection" })
      .where(eq(userIdentities.user_id, pair.telegram.user.id));
    expect(
      (await usersRepository.inspectPhoneTelegramPersonalAccountConvergence(proof)).status,
    ).toBe("identity_projection_conflict");
    expect(await dbWrite.select().from(users)).toHaveLength(2);
    expect(await dbWrite.select().from(organizations)).toHaveLength(2);
  });
});
