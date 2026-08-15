/**
 * Proves phone-first personal-account promotion and mature-account phone
 * linking against a real isolated PGlite schema. The suite pins identity
 * preservation, retry/concurrency idempotency, fail-closed ownership conflicts,
 * inbound lookup visibility, and two-table transactional rollback.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository phone identity transactions (real PGlite)", () => {
  let pgliteReady = true;
  let sequence = 0;

  const createPhoneAccount = async (phoneNumber: string) => {
    sequence += 1;
    return usersRepository.findOrCreatePhonePersonalAccount({
      phoneNumber,
      displayName: `Phone User ${sequence}`,
      organizationName: `Phone Workspace ${sequence}`,
      organizationSlug: `phone-workspace-${sequence}`,
    });
  };

  const createMatureUser = async () => {
    sequence += 1;
    const [organization] = await dbWrite
      .insert(organizations)
      .values({
        name: `Mature Organization ${sequence}`,
        slug: `mature-organization-${sequence}`,
        credit_balance: "0.00",
      })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `steward-mature-${sequence}`,
        organization_id: organization.id,
        role: "owner",
        is_active: true,
      })
      .returning();
    await dbWrite.insert(userIdentities).values({
      user_id: user.id,
      steward_user_id: user.steward_user_id,
    });
    return { user, organization };
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-promote-phone-personal-account.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
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
      // error-policy:J1 The test boundary records setup failure and every case fails loudly.
      pgliteReady = false;
      console.error(
        "[users-promote-phone-personal-account.test] PGlite schema setup failed.",
        error,
      );
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

  test("promotes the exact provisional account without replacing its user, org, or balance", async () => {
    const phoneNumber = "+14155550201";
    const provisional = await createPhoneAccount(phoneNumber);

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber,
      stewardUserId: "steward-real-201",
    });

    expect(result.status).toBe("promoted");
    if (result.status !== "promoted") return;
    expect(result.user.id).toBe(provisional.user.id);
    expect(result.user.organization_id).toBe(provisional.organization.id);
    expect(result.organization.id).toBe(provisional.organization.id);
    expect(result.organization.credit_balance).toBe("0.000000");

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, provisional.user.id));
    expect(projection).toMatchObject({
      user_id: provisional.user.id,
      steward_user_id: "steward-real-201",
      phone_number: phoneNumber,
      phone_verified: true,
    });
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
  });

  test("returns already_promoted for an idempotent retry", async () => {
    const phoneNumber = "+14155550202";
    const provisional = await createPhoneAccount(phoneNumber);
    const params = { phoneNumber, stewardUserId: "steward-real-202" };

    expect((await usersRepository.promotePhonePersonalAccountToSteward(params)).status).toBe(
      "promoted",
    );
    const retry = await usersRepository.promotePhonePersonalAccountToSteward(params);

    expect(retry.status).toBe("already_promoted");
    if (retry.status !== "already_promoted") return;
    expect(retry.user.id).toBe(provisional.user.id);
    expect(retry.organization.id).toBe(provisional.organization.id);
  });

  test("serializes concurrent retries onto one promoted account", async () => {
    const phoneNumber = "+14155550203";
    const provisional = await createPhoneAccount(phoneNumber);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        usersRepository.promotePhonePersonalAccountToSteward({
          phoneNumber,
          stewardUserId: "steward-real-203",
        }),
      ),
    );

    expect(results.filter((result) => result.status === "promoted")).toHaveLength(1);
    expect(results.filter((result) => result.status === "already_promoted")).toHaveLength(7);
    const [canonical] = await dbWrite.select().from(users);
    expect(canonical).toMatchObject({
      id: provisional.user.id,
      organization_id: provisional.organization.id,
      steward_user_id: "steward-real-203",
    });
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
  });

  test("does not merge a phone already owned by a mature account", async () => {
    const phoneNumber = "+14155550204";
    const provisional = await createPhoneAccount(phoneNumber);
    expect(
      (
        await usersRepository.promotePhonePersonalAccountToSteward({
          phoneNumber,
          stewardUserId: "steward-existing-204",
        })
      ).status,
    ).toBe("promoted");

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber,
      stewardUserId: "steward-other-204",
    });

    expect(result).toEqual({ status: "phone_owned_by_mature_account" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe("steward-existing-204");
  });

  test("refuses a Steward subject already owned by another user", async () => {
    const first = await createPhoneAccount("+14155550205");
    await createPhoneAccount("+14155550206");
    expect(
      (
        await usersRepository.promotePhonePersonalAccountToSteward({
          phoneNumber: "+14155550206",
          stewardUserId: "steward-collision",
        })
      ).status,
    ).toBe("promoted");

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber: "+14155550205",
      stewardUserId: "steward-collision",
    });

    expect(result).toEqual({ status: "steward_subject_owned_by_other_user" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, first.user.id));
    expect(canonical?.steward_user_id).toBe("phone:+14155550205");
  });

  test("reports not_found when no phone account or Steward subject exists", async () => {
    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber: "+14155550210",
      stewardUserId: "steward-real-210",
    });

    expect(result).toEqual({ status: "not_found" });
    expect(await dbWrite.select().from(users)).toHaveLength(0);
    expect(await dbWrite.select().from(organizations)).toHaveLength(0);
  });

  test("refuses an inactive provisional account", async () => {
    const phoneNumber = "+14155550207";
    const provisional = await createPhoneAccount(phoneNumber);
    await dbWrite.update(users).set({ is_active: false }).where(eq(users.id, provisional.user.id));

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber,
      stewardUserId: "steward-real-207",
    });

    expect(result).toEqual({ status: "phone_account_inactive" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe(`phone:${phoneNumber}`);
  });

  test("refuses a deleted provisional account", async () => {
    const phoneNumber = "+14155550208";
    const provisional = await createPhoneAccount(phoneNumber);
    await dbWrite
      .update(users)
      .set({ deleted_at: new Date() })
      .where(eq(users.id, provisional.user.id));

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber,
      stewardUserId: "steward-real-208",
    });

    expect(result).toEqual({ status: "phone_account_deleted" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe(`phone:${phoneNumber}`);
  });

  test("rolls back the canonical promotion when the identity projection conflicts", async () => {
    const phoneNumber = "+14155550209";
    const provisional = await createPhoneAccount(phoneNumber);
    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: "stale-projected-subject" })
      .where(eq(userIdentities.user_id, provisional.user.id));

    const result = await usersRepository.promotePhonePersonalAccountToSteward({
      phoneNumber,
      stewardUserId: "steward-real-209",
    });

    expect(result).toEqual({ status: "identity_projection_conflict" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe(`phone:${phoneNumber}`);
    expect(projection?.steward_user_id).toBe("stale-projected-subject");
  });

  test("links a mature account idempotently and exposes it to the next inbound phone lookup", async () => {
    const phoneNumber = "+14155550211";
    const mature = await createMatureUser();

    const first = await usersRepository.linkVerifiedPhone(mature.user.id, phoneNumber);
    const retry = await usersRepository.linkVerifiedPhone(mature.user.id, phoneNumber);

    expect(first?.id).toBe(mature.user.id);
    expect(retry?.id).toBe(mature.user.id);
    const inboundOwner = await usersRepository.findByPhoneNumberWithOrganization(phoneNumber);
    expect(inboundOwner).toMatchObject({
      id: mature.user.id,
      organization_id: mature.organization.id,
      phone_number: phoneNumber,
      phone_verified: true,
    });
    expect(inboundOwner?.organization?.id).toBe(mature.organization.id);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, mature.user.id));
    expect(projection).toMatchObject({
      phone_number: phoneNumber,
      phone_verified: true,
    });
  });

  test("repairs a missing mature-account projection while linking its verified phone", async () => {
    const phoneNumber = "+14155550215";
    const mature = await createMatureUser();
    await dbWrite.delete(userIdentities).where(eq(userIdentities.user_id, mature.user.id));

    await usersRepository.linkVerifiedPhone(mature.user.id, phoneNumber);

    const inboundOwner = await usersRepository.findByPhoneNumberWithOrganization(phoneNumber);
    expect(inboundOwner).toMatchObject({
      id: mature.user.id,
      steward_user_id: mature.user.steward_user_id,
      phone_number: phoneNumber,
      phone_verified: true,
    });
    expect(inboundOwner?.organization?.id).toBe(mature.organization.id);
  });

  test("refuses to replace a mature account's different verified phone", async () => {
    const originalPhone = "+14155550212";
    const mature = await createMatureUser();
    await usersRepository.linkVerifiedPhone(mature.user.id, originalPhone);

    await expect(
      usersRepository.linkVerifiedPhone(mature.user.id, "+14155550213"),
    ).rejects.toMatchObject({ code: "VERIFIED_PHONE_MISMATCH" });

    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, mature.user.id));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, mature.user.id));
    expect(canonical).toMatchObject({
      phone_number: originalPhone,
      phone_verified: true,
    });
    expect(projection).toMatchObject({
      phone_number: originalPhone,
      phone_verified: true,
    });
  });

  test("rolls back when another mature account already owns the verified phone", async () => {
    const phoneNumber = "+14155550214";
    const owner = await createMatureUser();
    const claimant = await createMatureUser();
    await usersRepository.linkVerifiedPhone(owner.user.id, phoneNumber);

    await expect(
      usersRepository.linkVerifiedPhone(claimant.user.id, phoneNumber),
    ).rejects.toThrow();

    const [claimantCanonical] = await dbWrite
      .select()
      .from(users)
      .where(eq(users.id, claimant.user.id));
    const [claimantProjection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, claimant.user.id));
    expect(claimantCanonical).toMatchObject({ phone_number: null, phone_verified: false });
    expect(claimantProjection).toMatchObject({ phone_number: null, phone_verified: false });
    expect((await usersRepository.findByPhoneNumberWithOrganization(phoneNumber))?.id).toBe(
      owner.user.id,
    );
  });
});
