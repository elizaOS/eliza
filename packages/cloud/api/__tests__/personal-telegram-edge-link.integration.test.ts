/** Proves the default edge LINK route carries canonical Worker request context into real SQL. */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import {
  closeDatabaseConnectionsForTests,
  dbWrite,
  hasDbCacheContext,
} from "@/db/client";
import { identityLinkCodes } from "@/db/schemas/identity-link-codes";
import {
  organizationBalanceRevisionSequence,
  organizations,
} from "@/db/schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "@/db/schemas/personal-shared-groups";
import { userIdentities } from "@/db/schemas/user-identities";
import { users } from "@/db/schemas/users";
import { hasCloudBindingsContext } from "@/lib/runtime/cloud-bindings";
import { getRequestIdempotencyKey } from "@/lib/runtime/request-context";
import { startIdentityLink } from "@/lib/services/eliza-app/identity-link";
import type { AppEnv } from "@/types/cloud-worker-env";
import { defaultConfirmIdentityLink } from "../eliza-app/webhook/_telegram-edge";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-000000000101";
let pgliteReady = true;

function executionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as unknown as ExecutionContext;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizationBalanceRevisionSequence,
        organizations,
        users,
        userIdentities,
        identityLinkCodes,
        personalSharedGroupBindings,
        personalSharedGroupJoinChallenges,
        personalSharedGroupParticipants,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(identityLinkCodes);
  await dbWrite.delete(userIdentities);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "Edge LINK test",
    slug: "edge-link-test",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "steward-edge-link",
    organization_id: ORG_ID,
  });
  await dbWrite.insert(userIdentities).values({
    user_id: USER_ID,
    steward_user_id: "steward-edge-link",
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("Personal Telegram default LINK route", () => {
  test("invalidates provisional routing and heals already_used replay inside canonical request context", async () => {
    const { code } = await startIdentityLink({
      userId: USER_ID,
      organizationId: ORG_ID,
      platform: "telegram",
    });
    const invalidations: string[] = [];
    const fetch = mock(async () => {
      expect(hasCloudBindingsContext()).toBe(true);
      expect(hasDbCacheContext()).toBe(true);
      expect(getRequestIdempotencyKey()).toMatch(
        /^identity-link:[0-9a-f]{64}$/,
      );
      invalidations.push("telegram:424242");
      return Response.json({ success: true });
    });
    const getByName = mock((name: string) => {
      expect(name).toBe("telegram:424242");
      return { fetch };
    });
    const env = {
      DATABASE_URL: "pglite://memory",
      PERSONAL_DELIVERY_PROJECTIONS: { getByName },
    } as unknown as AppEnv["Bindings"];
    const input = {
      code,
      platform: "telegram",
      platformId: "424242",
      platformName: "linked_owner",
    };

    const linked = await defaultConfirmIdentityLink(
      input,
      "11111111-1111-4111-8111-111111111111",
      env,
      executionContext(),
    );
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      success: true,
      data: { status: "linked", userId: USER_ID },
    });

    const replay = await defaultConfirmIdentityLink(
      input,
      "22222222-2222-4222-8222-222222222222",
      env,
      executionContext(),
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      success: false,
      data: { status: "already_used" },
    });
    expect(invalidations).toHaveLength(2);

    const owner = (
      await dbWrite
        .select({ id: users.id })
        .from(users)
        .where(eq(users.telegram_id, "424242"))
        .limit(1)
    )[0]?.id;
    expect(owner).toBe(USER_ID);
  });
});
