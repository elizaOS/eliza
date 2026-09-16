/** Exercises latest immutable schedule lineage and predecessor migration constraints on real PGlite transactions. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_lineage";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let client: typeof import("../client");
let repo: typeof import("./subscription-cancellation");
let lineage: typeof import("./subscription-schedule-lineage");
let helpers: typeof import("../helpers");
beforeAll(async () => {
  client = await import("../client");
  await installCancellationTestSchema((q) => client.getPgliteClientForTests().exec(q));
  repo = await import("./subscription-cancellation");
  lineage = await import("./subscription-schedule-lineage");
  helpers = await import("../helpers");
}, 120000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function applied() {
  const f = await seedCancellationTestAccount();
  const command = await repo.prepareCancellation(f.input);
  const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
  const raw = {
    ...f.provider,
    cancel_at_period_end: true,
    canceled_at: Math.floor(Date.now() / 1000),
    cancel_at: f.provider.current_period_end,
  };
  await repo.finalizeCancellation(f.input, claim!, raw);
  return { ...f, command };
}
async function latest(f: Awaited<ReturnType<typeof applied>>) {
  const { subscriptionAuthorityRepository } = await import("./subscription-authority");
  const source = await subscriptionAuthorityRepository.findById(
    f.input.organizationId,
    f.input.subscriptionId,
  );
  return helpers.writeTransaction((tx) =>
    lineage.readLatestSubscriptionScheduleCommand(tx, source!),
  );
}
test("latest applied result resolves by immutable revision and historical same-source duplicate result is explicit ambiguity", async () => {
  const f = await applied();
  expect((await latest(f))?.id).toBe(f.command.id);
  await client.getPgliteClientForTests().query(
    `INSERT INTO billing_subscription_commands(organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,status,execution_generation,provider_started_at,provider_response_digest,completed_at,result_subscription_id,result_subscription_revision,applied_at)
 SELECT organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key||'dup',provider_idempotency_key||'dup',request_digest,status,execution_generation,provider_started_at,provider_response_digest,completed_at,result_subscription_id,result_subscription_revision,applied_at FROM billing_subscription_commands WHERE id=$1`,
    [f.command.id],
  );
  await expect(latest(f)).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
});
test("resume provenance requires predecessor and cannot reference foreign tenant or mutate captured parent", async () => {
  const f = await applied();
  const other = await applied();
  const insert = (parent: string | null) =>
    client.getPgliteClientForTests().query(
      `INSERT INTO billing_subscription_commands(organization_id,subscription_id,requested_by_user_id,kind,expected_subscription_revision,idempotency_key,provider_idempotency_key,request_digest,cancellation_dispatch_state,schedule_predecessor_command_id)
 VALUES($1,$2,$3,'resume',2,$4,$4,$5,'ready',$6) RETURNING id`,
      [
        f.input.organizationId,
        f.input.subscriptionId,
        f.input.actorId,
        crypto.randomUUID(),
        "a".repeat(64),
        parent,
      ],
    );
  await expect(insert(null)).rejects.toThrow();
  await expect(insert(other.command.id)).rejects.toThrow();
  const row = await insert(f.command.id);
  const id = (row.rows[0] as { id: string }).id;
  await expect(
    client
      .getPgliteClientForTests()
      .query(
        "UPDATE billing_subscription_commands SET schedule_predecessor_command_id=NULL WHERE id=$1",
        [id],
      ),
  ).rejects.toThrow();
});

test("complete immutable lineage rejects an unowned undo and recancel even when current fields match the applied result", async () => {
  const f = await applied();
  const { subscriptionAuthorityRepository: authority } = await import("./subscription-authority");
  const result = await authority.findById(f.input.organizationId, f.input.subscriptionId);
  const {
    id: _id,
    organization_id: _org,
    lifecycle_revision: _revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = result!;
  await authority.advance({
    organizationId: f.input.organizationId,
    subscriptionId: f.input.subscriptionId,
    expectedRevision: 2,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      cancel_at_period_end: false,
      canceled_at: null,
      provider_object_digest: "e".repeat(64),
      last_provider_event_id: `evt_unowned${crypto.randomUUID().replaceAll("-", "")}`,
      last_provider_event_created_at: new Date(),
    },
  });
  await authority.advance({
    organizationId: f.input.organizationId,
    subscriptionId: f.input.subscriptionId,
    expectedRevision: 3,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      provider_object_digest: "f".repeat(64),
      last_provider_event_id: `evt_unowned${crypto.randomUUID().replaceAll("-", "")}`,
      last_provider_event_created_at: new Date(Date.now() + 1000),
    },
  });
  await expect(latest(f)).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
  await expect(
    repo.prepareCancellation(
      { ...f.input, expectedSubscriptionRevision: 4, idempotencyKey: crypto.randomUUID() },
      "resume",
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
});
