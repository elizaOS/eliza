/** Exercises actual undo-cancellation HTTP, SDK, primary command service and migrated billing authority; session verification and Stripe transport are controlled external boundaries. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "@/db/repositories/subscription-cancellation-test-fixture";
import type { AppEnv, AuthedUser } from "@/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_fixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let database: typeof import("@/db/client");
let fixture: Awaited<ReturnType<typeof seedCancellationTestAccount>>;
let provider: Awaited<
  ReturnType<typeof seedCancellationTestAccount>
>["provider"];
let mutations = 0,
  revokeAtRetrieval = false,
  loseResponse = false;
const effects: Array<{ params: unknown; options: unknown }> = [];
mock.module("@/lib/stripe", () => ({
  requireStripe: () => ({
    customers: {
      retrieve: async (id: string) => ({
        id,
        object: "customer",
        livemode: false,
      }),
    },
    subscriptions: {
      retrieve: async () => {
        if (revokeAtRetrieval) {
          revokeAtRetrieval = false;
          await database
            .getPgliteClientForTests()
            .query("UPDATE users SET role='member' WHERE id=$1", [
              fixture.input.actorId,
            ]);
        }
        return provider;
      },
      update: async (_id: string, params: unknown, options: unknown) => {
        mutations++;
        effects.push({ params, options });
        const change = z
          .object({ cancel_at_period_end: z.boolean() })
          .strict()
          .parse(params);
        provider = {
          ...provider,
          cancel_at_period_end: change.cancel_at_period_end,
          cancel_at: change.cancel_at_period_end
            ? provider.current_period_end
            : null,
          canceled_at: change.cancel_at_period_end
            ? Math.floor(Date.now() / 1000)
            : null,
        };
        if (loseResponse)
          throw new Error("provider accepted but response lost");
        return provider;
      },
    },
  }),
}));
mock.module("@/lib/auth/steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached: async () => ({ userId: "fixture-steward" }),
}));
mock.module("@/lib/auth/staging-session-binding", () => ({
  loadVerifiedStagingSessionUser: async () => null,
}));
mock.module("@/db/repositories/users", () => ({
  usersRepository: {
    findWithOrganizationForWrite: async () => {
      const result = await database.getPgliteClientForTests().query<{
        id: string;
        organization_id: string;
        role: string;
        is_active: boolean;
        is_anonymous: boolean;
        deleted_at: Date | null;
        expires_at: Date | null;
      }>("SELECT * FROM users WHERE id=$1", [fixture.input.actorId]);
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        ...row,
        steward_user_id: "fixture-steward",
        organization: {
          id: row.organization_id,
          is_active: true,
          name: "Fixture",
        },
        email: "owner@example.test",
        wallet_address: null,
      };
    },
  },
}));
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
    next(),
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
let app: Hono<AppEnv>;
let ElizaCloudClient: typeof import("../../../../../sdk/src/client").ElizaCloudClient;
beforeAll(async () => {
  database = await import("@/db/client");
  await installCancellationTestSchema((q) =>
    database.getPgliteClientForTests().exec(q),
  );
  await database
    .getPgliteClientForTests()
    .exec(
      "ALTER TABLE organizations ADD COLUMN account_lifecycle_revision bigint NOT NULL DEFAULT 1",
    );
  const { ROUTE_MOUNTS } = await import("../../../../src/_router.generated");
  const { cookieMutationGuardMiddleware } = await import(
    "../../../../src/middleware/cookie-mutation-guard"
  );
  ({ ElizaCloudClient } = await import("../../../../../sdk/src/client"));
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const user: AuthedUser = {
      id: fixture.input.actorId,
      organization_id: fixture.input.organizationId,
      organization: { id: fixture.input.organizationId, is_active: true },
      role: "owner",
      steward_id: "fixture-steward",
      is_active: true,
      is_anonymous: false,
    };
    c.set("user", user);
    c.set("authMethod", "session");
    await next();
  });
  app.use("*", cookieMutationGuardMiddleware);
  for (const mount of ROUTE_MOUNTS.filter((mount) =>
    mount.path.startsWith("/api/v1/subscriptions/cancel"),
  )) {
    app.route(mount.path, (await mount.load()).default);
  }
});
beforeEach(async () => {
  fixture = await seedCancellationTestAccount();
  provider = fixture.provider;
  mutations = 0;
  revokeAtRetrieval = false;
  loseResponse = false;
  effects.length = 0;
});
afterAll(async () => {
  await database.closeDatabaseConnectionsForTests();
});
const responseSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      commandId: z.string().uuid(),
      subscriptionId: z.string().uuid(),
      status: z.enum([
        "PREPARED",
        "OUTCOME_UNKNOWN",
        "APPLIED",
        "FAILED",
        "SUPERSEDED",
      ]),
      expectedSubscriptionRevision: z.string(),
      resultSubscriptionRevision: z.string().nullable(),
    })
    .strict(),
});
function client() {
  const fetchImpl: typeof fetch = Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => app.request(new Request(input, init)),
    { preconnect: fetch.preconnect },
  );
  return new ElizaCloudClient({
    baseUrl: "https://api.eliza.app",
    bearerToken: "fixture.session.jwt",
    fetchImpl,
  });
}
function input() {
  const { subscriptionId, expectedSubscriptionRevision, idempotencyKey } =
    fixture.input;
  return { subscriptionId, expectedSubscriptionRevision, idempotencyKey };
}
async function billingRows() {
  const pg = database.getPgliteClientForTests();
  return {
    balance: (
      await pg.query(
        "SELECT credit_balance::text FROM organizations WHERE id=$1",
        [fixture.input.organizationId],
      )
    ).rows,
    allowance: (
      await pg.query(
        "SELECT * FROM subscription_allowance_transactions WHERE organization_id=$1",
        [fixture.input.organizationId],
      )
    ).rows,
    notices: (
      await pg.query(
        "SELECT * FROM subscription_notice_intents WHERE organization_id=$1",
        [fixture.input.organizationId],
      )
    ).rows,
  };
}

async function scheduled() {
  const sdk = client();
  const cancel = responseSchema.parse(
    await sdk.submitOrganizationSubscriptionCancellation(input()),
  );
  expect(cancel.data.status).toBe("APPLIED");
  return {
    sdk,
    cancel,
    undo: {
      ...input(),
      expectedSubscriptionRevision: Number(
        cancel.data.resultSubscriptionRevision,
      ),
      idempotencyKey: crypto.randomUUID(),
    },
  };
}
test("real generated routes cancel then undo and retain kind-specific polling and exact replay", async () => {
  const { sdk, cancel, undo } = await scheduled();
  const before = await billingRows();
  const result = responseSchema.parse(
    await sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  );
  expect(result.data).toMatchObject({
    status: "APPLIED",
    resultSubscriptionRevision: "3",
  });
  expect(effects.map((effect) => effect.params)).toEqual([
    { cancel_at_period_end: true },
    { cancel_at_period_end: false },
  ]);
  expect(
    await sdk.readOrganizationSubscriptionCancellationUndo(
      result.data.commandId,
    ),
  ).toEqual(result);
  expect(
    await sdk.readOrganizationSubscriptionCancellation(cancel.data.commandId),
  ).toEqual(cancel);
  await expect(
    sdk.readOrganizationSubscriptionCancellation(result.data.commandId),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    sdk.readOrganizationSubscriptionCancellationUndo(cancel.data.commandId),
  ).rejects.toMatchObject({ statusCode: 404 });
  expect(
    await sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  ).toEqual(result);
  expect(mutations).toBe(2);
  expect(await billingRows()).toEqual(before);
  expect(
    (
      await database
        .getPgliteClientForTests()
        .query(
          "SELECT status,cancel_at_period_end,ended_at,lifecycle_revision FROM billing_subscriptions WHERE id=$1",
          [fixture.input.subscriptionId],
        )
    ).rows,
  ).toEqual([
    {
      status: "active",
      cancel_at_period_end: false,
      ended_at: null,
      lifecycle_revision: 3,
    },
  ]);
});
test("uncertain undo retries retrieve without repeating provider update", async () => {
  const { sdk, undo } = await scheduled();
  loseResponse = true;
  const unknown = responseSchema.parse(
    await sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  );
  expect(unknown.data.status).toBe("OUTCOME_UNKNOWN");
  expect(mutations).toBe(2);
  loseResponse = false;
  const recovered = responseSchema.parse(
    await sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  );
  expect(recovered.data.status).toBe("APPLIED");
  expect(mutations).toBe(2);
});
test("primary manager revocation during undo retrieval blocks external mutation", async () => {
  const { sdk, undo } = await scheduled();
  revokeAtRetrieval = true;
  await expect(
    sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(mutations).toBe(1);
  expect(provider.cancel_at_period_end).toBe(true);
});
test("foreign organization cannot submit or poll an undo command", async () => {
  const { sdk, undo } = await scheduled();
  const result = responseSchema.parse(
    await sdk.submitOrganizationSubscriptionCancellationUndo(undo),
  );
  const original = fixture;
  fixture = await seedCancellationTestAccount();
  provider = fixture.provider;
  await expect(
    client().readOrganizationSubscriptionCancellationUndo(
      result.data.commandId,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    client().submitOrganizationSubscriptionCancellationUndo({
      ...undo,
      subscriptionId: original.input.subscriptionId,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(mutations).toBe(2);
});
