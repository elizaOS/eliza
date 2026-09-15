/** Exercises actual pending-command HTTP/SDK and migrated primary authority; only identity verification and rate-limit transport are controlled boundaries. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
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
let sessionValid = true;
let revokeAfterSessionRead = false;
let presentedAuth: "session" | "api_key" = "session";
mock.module("@/lib/auth/steward-client", () => ({
  isStagingSessionTokenCandidate: () => false,
  verifyStewardTokenCached: async () =>
    sessionValid ? { userId: "fixture-steward" } : null,
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
      if (revokeAfterSessionRead) {
        revokeAfterSessionRead = false;
        await database
          .getPgliteClientForTests()
          .query("UPDATE users SET role='member' WHERE id=$1", [row.id]);
      }
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
let ElizaCloudClient: typeof import("../../../../sdk/src/client").ElizaCloudClient;
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
  const { default: commandsRoute } = await import("./route");
  const { cookieMutationGuardMiddleware } = await import(
    "../../../src/middleware/cookie-mutation-guard"
  );
  ({ ElizaCloudClient } = await import("../../../../sdk/src/client"));
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
    c.set("authMethod", presentedAuth);
    await next();
  });
  app.use("*", cookieMutationGuardMiddleware);
  app.route("/api/v1/subscriptions/commands", commandsRoute);
});
beforeEach(async () => {
  fixture = await seedCancellationTestAccount();
  sessionValid = true;
  revokeAfterSessionRead = false;
  presentedAuth = "session";
});
afterAll(async () => {
  await database.closeDatabaseConnectionsForTests();
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

const url = "https://api.eliza.app/api/v1/subscriptions/commands";
function get(query = "limit=20", token = "fixture.session.jwt") {
  return app.request(`${url}?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
async function prepare() {
  const repo = await import("@/db/repositories/subscription-cancellation");
  return repo.prepareCancellation(fixture.input);
}
/** Historical rows can predate the command writer's one-pending-intent guard; the migration permits them. */
async function pending(
  id: string = crypto.randomUUID(),
  kind: "cancel" | "resume" = "cancel",
) {
  await database
    .getPgliteClientForTests()
    .query(
      `INSERT INTO billing_subscription_commands(id,organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,cancellation_dispatch_state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'ready')`,
      [
        id,
        fixture.input.organizationId,
        fixture.input.subscriptionId,
        fixture.input.actorId,
        kind,
        id,
        `provider-${id}`,
        "a".repeat(64),
      ],
    );
  return { id };
}

test("returning manager discovers real uncertain command through SDK without knowing its ID", async () => {
  const command = await prepare();
  const repo = await import("@/db/repositories/subscription-cancellation");
  await repo.claimCancellation({ ...fixture.input, commandId: command.id });
  const before = (
    await database
      .getPgliteClientForTests()
      .query("SELECT * FROM billing_subscription_commands WHERE id=$1", [
        command.id,
      ])
  ).rows;
  const result = await client().listPendingOrganizationSubscriptionCommands({
    limit: 20,
  });
  expect(result.data.items).toHaveLength(1);
  expect(result.data.items[0]).toMatchObject({
    commandId: command.id,
    status: "OUTCOME_UNKNOWN",
    kind: "cancel",
    lease: "active",
    source: { state: "current", currentSubscriptionRevision: "1" },
  });
  expect(Object.keys(result.data.items[0]!).sort()).toEqual(
    [
      "commandId",
      "createdAt",
      "expectedSubscriptionRevision",
      "kind",
      "lease",
      "source",
      "status",
      "subscriptionId",
    ].sort(),
  );
  expect(
    (
      await database
        .getPgliteClientForTests()
        .query("SELECT * FROM billing_subscription_commands WHERE id=$1", [
          command.id,
        ])
    ).rows,
  ).toEqual(before);
});
test("same-microsecond rows paginate without omissions and malformed or foreign cursors never restart", async () => {
  const ids = [
    "10000000-0000-4000-8000-000000000001",
    "10000000-0000-4000-8000-000000000002",
    "10000000-0000-4000-8000-000000000003",
  ];
  for (const id of ids) await pending(id);
  await database
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET created_at='2026-09-06T01:02:03.123456Z' WHERE organization_id=$1",
      [fixture.input.organizationId],
    );
  const sdk = client();
  const first = await sdk.listPendingOrganizationSubscriptionCommands({
    limit: 1,
  });
  expect(first.data.items[0]!.commandId).toBe(ids[2]);
  expect(first.data.items[0]!.createdAt).toBe("2026-09-06T01:02:03.123456Z");
  const second = await sdk.listPendingOrganizationSubscriptionCommands({
    limit: 1,
    cursor: first.data.nextCursor!,
  });
  const third = await sdk.listPendingOrganizationSubscriptionCommands({
    limit: 1,
    cursor: second.data.nextCursor!,
  });
  expect(
    [first, second, third].flatMap((page) =>
      page.data.items.map((item) => item.commandId),
    ),
  ).toEqual([...ids].reverse());
  expect(third.data.nextCursor).toBeNull();
  expect((await get("limit=1&cursor=garbage")).status).toBe(400);
  expect((await get("limit=1&cursor=")).status).toBe(400);
  fixture = await seedCancellationTestAccount();
  expect((await get(`limit=1&cursor=${first.data.nextCursor}`)).status).toBe(
    400,
  );
  expect(
    (await client().listPendingOrganizationSubscriptionCommands({ limit: 20 }))
      .data.items,
  ).toEqual([]);
});
test("lease expiry follows database time and cleared leases remain visibly unleased", async () => {
  const command = await prepare();
  const repo = await import("@/db/repositories/subscription-cancellation");
  await repo.claimCancellation({ ...fixture.input, commandId: command.id });
  await database
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",
      [command.id],
    );
  expect(
    (await client().listPendingOrganizationSubscriptionCommands({ limit: 1 }))
      .data.items[0]!.lease,
  ).toBe("expired");
  await database
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=NULL,lease_token=NULL WHERE id=$1",
      [command.id],
    );
  expect(
    (await client().listPendingOrganizationSubscriptionCommands({ limit: 1 }))
      .data.items[0]!.lease,
  ).toBe("unleased");
});
test("pages reflect state changes instead of promising a cross-request snapshot", async () => {
  const a = await pending(),
    b = await pending(),
    c = await pending();
  const sdk = client();
  const first = await sdk.listPendingOrganizationSubscriptionCommands({
    limit: 1,
  });
  const remaining = [a, b, c]
    .map((row) => row.id)
    .filter((id) => id !== first.data.items[0]!.commandId);
  const { subscriptionBillingOperationsRepository: operations } = await import(
    "@/db/repositories/subscription-billing-operations"
  );
  await operations.supersedePreparedCommand({
    organizationId: fixture.input.organizationId,
    commandId: remaining[0]!,
    errorCode: "source_changed",
    expectedStateRevision: 1,
  });
  const next = await sdk.listPendingOrganizationSubscriptionCommands({
    limit: 20,
    cursor: first.data.nextCursor!,
  });
  expect(next.data.items.map((item) => item.commandId)).toEqual([
    remaining[1]!,
  ]);
});
test("changed current source is visible without pretending the pending command applied", async () => {
  const command = await prepare();
  const { subscriptionAuthorityRepository: authority } = await import(
    "@/db/repositories/subscription-authority"
  );
  await authority.advance({
    organizationId: fixture.input.organizationId,
    subscriptionId: fixture.input.subscriptionId,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...fixture.source,
      status: "canceled",
      ended_at: new Date(),
      last_provider_event_id: `evt_${crypto.randomUUID().replaceAll("-", "")}`,
      last_provider_event_created_at: new Date(),
      provider_object_digest: "b".repeat(64),
    },
  });
  expect(
    (await client().listPendingOrganizationSubscriptionCommands({ limit: 20 }))
      .data.items[0],
  ).toMatchObject({
    commandId: command.id,
    status: "PREPARED",
    source: { state: "changed", currentSubscriptionRevision: "2" },
  });
});
test("session, membership and deletion fences are rechecked against primary authority", async () => {
  await prepare();
  sessionValid = false;
  expect((await get()).status).toBe(401);
  sessionValid = true;
  expect((await get("limit=20", "eliza_test_developer_key")).status).toBe(401);
  await database
    .getPgliteClientForTests()
    .query("UPDATE users SET role='member' WHERE id=$1", [
      fixture.input.actorId,
    ]);
  expect((await get()).status).toBe(403);
  await database
    .getPgliteClientForTests()
    .query("UPDATE users SET role='admin' WHERE id=$1", [
      fixture.input.actorId,
    ]);
  expect((await get()).status).toBe(200);
  await database
    .getPgliteClientForTests()
    .query(
      "UPDATE organizations SET paid_work_fenced_at=clock_timestamp() WHERE id=$1",
      [fixture.input.organizationId],
    );
  expect((await get()).status).toBe(403);
});
test("pagination requires an explicit valid limit and no client tenant authority", async () => {
  for (const query of [
    "",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=no",
    "limit=1&organizationId=foreign",
  ]) {
    expect((await get(query)).status).toBe(400);
  }
});

test("membership revoked after the session helper read is rejected by the same-transaction primary recheck", async () => {
  await prepare();
  revokeAfterSessionRead = true;
  expect((await get()).status).toBe(403);
});

test("pending undo is discoverable while the completed cancellation is omitted", async () => {
  const repo = await import("@/db/repositories/subscription-cancellation");
  const cancellation = await prepare();
  const claim = await repo.claimCancellation({
    ...fixture.input,
    commandId: cancellation.id,
  });
  if (!claim) throw new Error("Expected real cancellation claim");
  await repo.finalizeCancellation(fixture.input, claim, {
    ...fixture.provider,
    cancel_at_period_end: true,
    cancel_at: fixture.provider.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  });
  const undo = await repo.prepareCancellation(
    {
      ...fixture.input,
      expectedSubscriptionRevision: 2,
      idempotencyKey: crypto.randomUUID(),
    },
    "resume",
  );
  const result = await client().listPendingOrganizationSubscriptionCommands({
    limit: 20,
  });
  expect(result.data.items).toHaveLength(1);
  expect(result.data.items[0]).toMatchObject({
    commandId: undo.id,
    kind: "resume",
    status: "PREPARED",
    lease: "not_started",
    expectedSubscriptionRevision: "2",
    source: { state: "current", currentSubscriptionRevision: "2" },
  });
});
