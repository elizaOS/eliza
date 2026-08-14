/**
 * Real-DB regression suite for `UsersRepository.linkTelegramAndPhoneIdentity`
 * (PR #18101): a session-based Telegram+phone link must update the canonical
 * `users` row AND the `user_identities` projection in one transaction, because
 * sessionless auth (`findByTelegramIdWithOrganization`,
 * `findByPhoneNumberWithOrganization`) resolves users through
 * `user_identities` only. Also pins the fail-closed collision behavior (no
 * half-linked state survives a uniqueness violation in either table) and the
 * refusal to overwrite a different already-verified phone number.
 *
 * Runs against an isolated in-process PGlite database (real schema via
 * pushSchema); nothing on the repository is mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// PGlite isolation harness (mirrors agent-billing-numeric.test.ts): the suite
// fails LOUDLY against a shared non-PGlite Postgres.
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { isUniqueConstraintError } from "../../../lib/utils/db-errors";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { organizations } from "../../schemas/organizations";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository.linkTelegramAndPhoneIdentity (real PGlite)", () => {
  let pgliteReady = true;
  let seq = 0;
  const uniq = (prefix: string): string => {
    seq += 1;
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const createOrg = async () => {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Link Org", slug: uniq("org"), credit_balance: "0.00" })
      .returning();
    return org;
  };

  const createUser = async (
    overrides: Partial<typeof users.$inferInsert> = {},
  ): Promise<typeof users.$inferSelect> => {
    const org = await createOrg();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: uniq("steward"),
        name: "Link Test User",
        organization_id: org.id,
        role: "owner",
        is_active: true,
        ...overrides,
      })
      .returning();
    return user;
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-link-telegram-phone.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); pushSchema against a shared connection would mutate the shared schema. Skipping.",
      );
      return;
    }
    try {
      const schema = { organizations, users, userIdentities };
      const { apply } = await pushSchema(schema as never, dbWrite as never);
      await apply();
    } catch (error) {
      pgliteReady = false;
      console.error(
        "[users-link-telegram-phone.test] PGlite/pushSchema unavailable — cannot drive UsersRepository against a real DB.",
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

  test("linking writes users AND user_identities so sessionless lookups resolve the user", async () => {
    const user = await createUser();
    const telegramId = uniq("tg");
    const phone = "+14155550101";

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(result.status).toBe("linked");

    const byTelegram = await usersRepository.findByTelegramIdWithOrganization(telegramId);
    expect(byTelegram?.id).toBe(user.id);
    expect(user.organization_id).not.toBeNull();
    expect(byTelegram?.organization?.id).toBe(user.organization_id as string);

    const byPhone = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(byPhone?.id).toBe(user.id);

    const canonical = await usersRepository.findById(user.id);
    expect(canonical?.telegram_id).toBe(telegramId);
    expect(canonical?.phone_number).toBe(phone);
    expect(canonical?.phone_verified).toBe(true);
  });

  test("re-linking the same phone is idempotent and refreshes the Telegram profile", async () => {
    const user = await createUser();
    const telegramId = uniq("tg");
    const phone = "+14155550102";

    const first = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "old",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(first.status).toBe("linked");

    const second = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "new",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(second.status).toBe("linked");

    const identity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, user.id),
    });
    expect(identity?.telegram_username).toBe("new");
    expect(identity?.phone_number).toBe(phone);
  });

  test("a Telegram identity owned by another user fails the whole link — no half-link in either table", async () => {
    const owner = await createUser();
    const telegramId = uniq("tg");
    const ownerLink = await usersRepository.linkTelegramAndPhoneIdentity(owner.id, {
      telegram_id: telegramId,
      telegram_username: "owner",
      telegram_first_name: "Own",
      phone_number: "+14155550103",
    });
    expect(ownerLink.status).toBe("linked");

    const intruder = await createUser();
    const telegramCollision = await usersRepository
      .linkTelegramAndPhoneIdentity(intruder.id, {
        telegram_id: telegramId,
        telegram_username: "intruder",
        telegram_first_name: "Bad",
        phone_number: "+14155550104",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueConstraintError(telegramCollision)).toBe(true);

    const intruderRow = await usersRepository.findById(intruder.id);
    expect(intruderRow?.telegram_id).toBeNull();
    expect(intruderRow?.phone_number).toBeNull();

    const intruderIdentity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, intruder.id),
    });
    expect(intruderIdentity).toBeUndefined();

    const stillOwner = await usersRepository.findByTelegramIdWithOrganization(telegramId);
    expect(stillOwner?.id).toBe(owner.id);
  });

  test("a phone identity owned by another user fails the whole link — no half-link in either table", async () => {
    const owner = await createUser();
    const phone = "+14155550105";
    const ownerLink = await usersRepository.linkTelegramAndPhoneIdentity(owner.id, {
      telegram_id: uniq("tg"),
      telegram_username: "owner",
      telegram_first_name: "Own",
      phone_number: phone,
    });
    expect(ownerLink.status).toBe("linked");

    const intruder = await createUser();
    const phoneCollision = await usersRepository
      .linkTelegramAndPhoneIdentity(intruder.id, {
        telegram_id: uniq("tg"),
        telegram_username: "intruder",
        telegram_first_name: "Bad",
        phone_number: phone,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueConstraintError(phoneCollision)).toBe(true);

    const intruderRow = await usersRepository.findById(intruder.id);
    expect(intruderRow?.telegram_id).toBeNull();
    expect(intruderRow?.phone_number).toBeNull();

    const intruderIdentity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, intruder.id),
    });
    expect(intruderIdentity).toBeUndefined();

    const stillOwner = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(stillOwner?.id).toBe(owner.id);
  });

  test("refuses to overwrite a different verified phone number and mutates nothing", async () => {
    const existingPhone = "+14155550106";
    const user = await createUser({ phone_number: existingPhone, phone_verified: true });

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: uniq("tg"),
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: "+14155550107",
    });

    expect(result).toEqual({ status: "phone_mismatch", existingPhone });

    const canonical = await usersRepository.findById(user.id);
    expect(canonical?.phone_number).toBe(existingPhone);
    expect(canonical?.telegram_id).toBeNull();

    const identity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, user.id),
    });
    expect(identity).toBeUndefined();
  });

  test("an unverified placeholder phone may be replaced", async () => {
    const user = await createUser({ phone_number: "+14155550108", phone_verified: false });
    const phone = "+14155550109";

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: uniq("tg"),
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(result.status).toBe("linked");

    const byPhone = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(byPhone?.id).toBe(user.id);
  });

  test("a missing user reports user_not_found", async () => {
    const result = await usersRepository.linkTelegramAndPhoneIdentity(
      "00000000-0000-0000-0000-000000000000",
      {
        telegram_id: uniq("tg"),
        phone_number: "+14155550110",
      },
    );
    expect(result).toEqual({ status: "user_not_found" });
  });
});
