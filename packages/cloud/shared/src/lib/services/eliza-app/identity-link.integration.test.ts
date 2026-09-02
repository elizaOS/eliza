/**
 * Exercises identity-link code mint/confirm against the real Drizzle schema on
 * isolated PGlite: single-use consumption (replay -> already_used), expiry,
 * platform mismatch, cross-account handle-conflict rejection, and the actual
 * canonical + projection binding writes. Real SQL, no rollback-capable mocks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../../db/client";
import { usersRepository } from "../../../db/repositories/users";
import { identityLinkCodes } from "../../../db/schemas/identity-link-codes";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "../../../db/schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../../../db/schemas/personal-shared-groups";
import { userIdentities } from "../../../db/schemas/user-identities";
import { users } from "../../../db/schemas/users";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { runWithCloudBindingsAsync } from "../../runtime/cloud-bindings";
import { confirmIdentityLink, startIdentityLink } from "./identity-link";
import { PERSONAL_DELIVERY_PROJECTION_BINDING } from "./personal-delivery-projection-contract";

const PGLITE_TIMEOUT = 60_000;
const ORG_A = "00000000-0000-4000-8000-00000000a001";
const ORG_B = "00000000-0000-4000-8000-00000000a002";
const USER_A = "00000000-0000-4000-8000-000000000101";
const USER_B = "00000000-0000-4000-8000-000000000102";
let pgliteReady = true;

async function seedAccount(userId: string, orgId: string, stewardUserId: string): Promise<void> {
  await dbWrite
    .insert(organizations)
    .values({ id: orgId, name: `org-${stewardUserId}`, slug: `org-${stewardUserId}` })
    .onConflictDoNothing();
  await dbWrite
    .insert(users)
    .values({ id: userId, steward_user_id: stewardUserId, organization_id: orgId });
  await dbWrite.insert(userIdentities).values({ user_id: userId, steward_user_id: stewardUserId });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[identity-link.integration.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
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
        personalSharedGroupBindings,
        personalSharedGroupJoinChallenges,
        personalSharedGroupParticipants,
        identityLinkCodes,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 The test boundary records schema setup failure and every case fails loudly.
    pgliteReady = false;
    console.error("[identity-link.integration.test] PGlite schema setup failed.", error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(identityLinkCodes);
  await dbWrite.delete(userIdentities);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("startIdentityLink", () => {
  test("mints a prefixed pending code and supersedes the previous pending code", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");

    const first = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });
    expect(first.code).toMatch(/^LINK-[A-HJ-NP-Z2-9]{8}$/);
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const second = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });
    expect(second.code).not.toBe(first.code);

    const rows = await dbWrite.select().from(identityLinkCodes);
    const byCode = new Map(rows.map((row) => [`LINK-${row.code}`, row.status]));
    expect(byCode.get(first.code)).toBe("expired");
    expect(byCode.get(second.code)).toBe("pending");
  });

  test("serializes concurrent starts so exactly one code remains pending", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");

    const results = await Promise.all([
      startIdentityLink({ userId: USER_A, organizationId: ORG_A, platform: "discord" }),
      startIdentityLink({ userId: USER_A, organizationId: ORG_A, platform: "discord" }),
    ]);

    expect(results[0].code).not.toBe(results[1].code);
    const rows = await dbWrite
      .select()
      .from(identityLinkCodes)
      .where(eq(identityLinkCodes.platform, "discord"));
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "expired")).toHaveLength(1);
  });

  test("rejects a user and organization from different accounts", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    await seedAccount(USER_B, ORG_B, "steward-b");

    await expect(
      startIdentityLink({ userId: USER_A, organizationId: ORG_B, platform: "telegram" }),
    ).rejects.toMatchObject({ code: "IDENTITY_LINK_ACCOUNT_MISMATCH" });
    expect(await dbWrite.select().from(identityLinkCodes)).toHaveLength(0);
  });
});

describe("confirmIdentityLink", () => {
  test("invalidates a cached provisional sender before the next Telegram resolve", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "telegram",
    });

    let cachedOwner: string | null = USER_B;
    const fetch = mock(async () => {
      cachedOwner = null;
      return Response.json({ success: true });
    });
    const getByName = mock(() => ({ fetch }));

    const confirmed = await runWithCloudBindingsAsync(
      {
        [PERSONAL_DELIVERY_PROJECTION_BINDING]: {
          getByName,
        } as unknown as RuntimeDurableObjectNamespace,
      },
      () =>
        confirmIdentityLink({
          code,
          platform: "telegram",
          platformId: "424242",
          platformName: "linked_owner",
        }),
    );

    expect(confirmed).toMatchObject({ status: "linked", userId: USER_A });
    expect(getByName).toHaveBeenCalledWith("telegram:424242");
    expect(fetch).toHaveBeenCalledTimes(1);

    const nextOwner =
      cachedOwner ??
      (
        await dbWrite
          .select({ id: users.id })
          .from(users)
          .where(eq(users.telegram_id, "424242"))
          .limit(1)
      )[0]?.id;
    expect(nextOwner).toBe(USER_A);
  });

  test("a matching LINK replay heals a transient projection invalidation failure", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "discord",
    });

    let attempts = 0;
    const fetch = mock(async () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ success: true });
    });
    const bindings = {
      [PERSONAL_DELIVERY_PROJECTION_BINDING]: {
        getByName: () => ({ fetch }),
      } as unknown as RuntimeDurableObjectNamespace,
    };
    const confirmation = {
      code,
      platform: "discord" as const,
      platformId: "987654321",
      platformName: "linked_owner",
    };

    await expect(
      runWithCloudBindingsAsync(bindings, () => confirmIdentityLink(confirmation)),
    ).rejects.toThrow("projection invalidation failed with status 503");
    expect(
      await runWithCloudBindingsAsync(bindings, () => confirmIdentityLink(confirmation)),
    ).toEqual({ status: "already_used" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("binds the handle once and reports replay as already_used", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });

    const confirmed = await confirmIdentityLink({
      code,
      platform: "whatsapp",
      platformId: "15551230001",
      platformName: "Sam",
    });
    expect(confirmed).toMatchObject({
      status: "linked",
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });

    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, USER_A));
    expect(canonical.whatsapp_id).toBe("15551230001");
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, USER_A));
    expect(projection.whatsapp_id).toBe("15551230001");

    const replayed = await confirmIdentityLink({
      code,
      platform: "whatsapp",
      platformId: "15551230001",
    });
    expect(replayed).toEqual({ status: "already_used" });
  });

  test("tolerates case and missing prefix in the typed code", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "telegram",
    });
    const bare = code.slice("LINK-".length).toLowerCase();
    const confirmed = await confirmIdentityLink({
      code: bare,
      platform: "telegram",
      platformId: "424242",
      platformName: "sam_tg",
    });
    expect(confirmed.status).toBe("linked");
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, USER_A));
    expect(canonical.telegram_id).toBe("424242");
  });

  test("reports an unknown code as code_not_found", async () => {
    const result = await confirmIdentityLink({
      code: "LINK-ZZZZZZZZ",
      platform: "whatsapp",
      platformId: "15551230002",
    });
    expect(result).toEqual({ status: "code_not_found" });
  });

  test("reports an expired code as expired and never binds", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });
    await dbWrite
      .update(identityLinkCodes)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(identityLinkCodes.code, code.slice("LINK-".length)));

    const result = await confirmIdentityLink({
      code,
      platform: "whatsapp",
      platformId: "15551230003",
    });
    expect(result).toEqual({ status: "expired" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, USER_A));
    expect(canonical.whatsapp_id).toBeNull();
  });

  test("rejects a confirm from the wrong platform without consuming the code", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });

    const mismatch = await confirmIdentityLink({
      code,
      platform: "telegram",
      platformId: "424242",
    });
    expect(mismatch).toEqual({ status: "platform_mismatch", expectedPlatform: "whatsapp" });

    const stillValid = await confirmIdentityLink({
      code,
      platform: "whatsapp",
      platformId: "15551230004",
    });
    expect(stillValid.status).toBe("linked");
  });

  test("rejects a handle already linked to a different account (cross-account confirm)", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    await seedAccount(USER_B, ORG_B, "steward-b");
    await usersRepository.linkWhatsAppIdentity(USER_B, {
      whatsapp_id: "15551230005",
      whatsapp_name: "Owner B",
    });

    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "whatsapp",
    });
    const result = await confirmIdentityLink({
      code,
      platform: "whatsapp",
      platformId: "15551230005",
    });
    expect(result).toEqual({ status: "handle_conflict" });

    // The victim's handle keeps its owner and the code stays consumable by the
    // legitimate flow.
    const [ownerB] = await dbWrite.select().from(users).where(eq(users.id, USER_B));
    expect(ownerB.whatsapp_id).toBe("15551230005");
    const [pending] = await dbWrite
      .select({ status: identityLinkCodes.status })
      .from(identityLinkCodes)
      .where(eq(identityLinkCodes.code, code.slice("LINK-".length)));
    expect(pending.status).toBe("pending");
  });

  test("atomically allows only one account to claim a previously free handle", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    await seedAccount(USER_B, ORG_B, "steward-b");
    const first = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "discord",
    });
    const second = await startIdentityLink({
      userId: USER_B,
      organizationId: ORG_B,
      platform: "discord",
    });

    const results = await Promise.all([
      confirmIdentityLink({
        code: first.code,
        platform: "discord",
        platformId: "shared-discord-handle",
      }),
      confirmIdentityLink({
        code: second.code,
        platform: "discord",
        platformId: "shared-discord-handle",
      }),
    ]);
    expect(results.filter((result) => result.status === "linked")).toHaveLength(1);
    expect(results.filter((result) => result.status === "handle_conflict")).toHaveLength(1);

    const codeRows = await dbWrite
      .select({ status: identityLinkCodes.status })
      .from(identityLinkCodes);
    expect(codeRows.filter((row) => row.status === "linked")).toHaveLength(1);
    expect(codeRows.filter((row) => row.status === "pending")).toHaveLength(1);
    const canonicalOwners = await dbWrite
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discord_id, "shared-discord-handle"));
    const projectionOwners = await dbWrite
      .select({ userId: userIdentities.user_id })
      .from(userIdentities)
      .where(eq(userIdentities.discord_id, "shared-discord-handle"));
    expect(canonicalOwners).toHaveLength(1);
    expect(projectionOwners).toEqual([{ userId: canonicalOwners[0].id }]);
  });

  test("normalizes and binds a phone handle end to end", async () => {
    await seedAccount(USER_A, ORG_A, "steward-a");
    const { code } = await startIdentityLink({
      userId: USER_A,
      organizationId: ORG_A,
      platform: "phone",
    });
    const result = await confirmIdentityLink({
      code,
      platform: "phone",
      platformId: "+1 (415) 555-0123",
    });
    expect(result.status).toBe("linked");
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, USER_A));
    expect(canonical.phone_number).toBe("+14155550123");
    expect(canonical.phone_verified).toBe(true);
  });
});
