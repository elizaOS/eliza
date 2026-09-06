/** Exercises explicit command-origin lifecycle publication and legacy command fencing against migrated PGlite authority, leases and immutable journals. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { installOrganizationPolicyTestSchema } from "./organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
let client: typeof import("../client");
let authority: typeof import("./subscription-authority").subscriptionAuthorityRepository;
let operations: typeof import("./subscription-billing-operations").subscriptionBillingOperationsRepository;
let entitlements: typeof import("./subscription-entitlements").subscriptionEntitlementsRepository;
let writeTransaction: typeof import("../helpers").writeTransaction;
beforeAll(async () => {
  client = await import("../client");
  const db = client.getPgliteClientForTests();
  await db.exec(
    "CREATE TABLE organizations(id uuid PRIMARY KEY); CREATE TABLE users(id uuid PRIMARY KEY);",
  );
  await installOrganizationPolicyTestSchema((query) => db.exec(query));
  for (const name of [
    "0383_subscription_cancellation_result.sql",
    "0384_subscription_cancellation_undo.sql",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await db.exec(statement);
  }
  ({ subscriptionAuthorityRepository: authority } = await import("./subscription-authority"));
  ({ subscriptionBillingOperationsRepository: operations } = await import(
    "./subscription-billing-operations"
  ));
  ({ subscriptionEntitlementsRepository: entitlements } = await import(
    "./subscription-entitlements"
  ));
  ({ writeTransaction } = await import("../helpers"));
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function fixture() {
  const organizationId = randomUUID(),
    subscriptionId = randomUUID(),
    userId = randomUUID(),
    commandId = randomUUID(),
    leaseToken = randomUUID();
  const suffix = subscriptionId.replaceAll("-", "");
  const eventId = `evt_${suffix}`;
  const eventTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const values = {
    provider: "stripe" as const,
    provider_environment: "test" as const,
    stripe_customer_id: `cus_${suffix}`,
    stripe_subscription_id: `sub_${suffix}`,
    stripe_subscription_item_id: `si_${suffix}`,
    catalog_version: "v1",
    plan_key: "plus_monthly" as const,
    status: "active" as const,
    current_period_start: new Date(Date.now() - 86_400_000),
    current_period_end: new Date(Date.now() + 86_400_000),
    cancel_at_period_end: false,
    canceled_at: null,
    ended_at: null,
    dunning_started_at: null,
    grace_expires_at: null,
    pending_plan_key: null,
    last_provider_event_id: null,
    last_provider_event_created_at: null,
    provider_object_digest: "a".repeat(64),
  };
  await client
    .getPgliteClientForTests()
    .query("INSERT INTO organizations(id,stripe_customer_id) VALUES($1,$2)", [
      organizationId,
      values.stripe_customer_id,
    ]);
  await client.getPgliteClientForTests().query("INSERT INTO users(id) VALUES($1)", [userId]);
  await authority.create(
    { ...values, id: subscriptionId, organization_id: organizationId },
    "checkout",
    null,
  );
  const webhookValues = {
    ...values,
    last_provider_event_id: eventId,
    last_provider_event_created_at: eventTime,
    provider_object_digest: "b".repeat(64),
  };
  await authority.advance({
    organizationId,
    subscriptionId,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: webhookValues,
  });
  await entitlements.rebuild({
    organizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: 2,
    expectedProjectionRevision: 0,
  });
  await operations.enqueueCommand({
    id: commandId,
    organizationId,
    subscriptionId,
    requestedByUserId: userId,
    kind: "cancel",
    targetPlanKey: null,
    expectedSubscriptionRevision: 2,
    idempotencyKey: `cancel:${commandId}`,
    providerIdempotencyKey: `provider:${commandId}`,
    requestDigest: "c".repeat(64),
    now: new Date(),
  });
  const {
    last_provider_event_id: _event,
    last_provider_event_created_at: _time,
    ...commandValues
  } = values;
  const input = {
    organizationId,
    subscriptionId,
    expectedRevision: 2,
    commandId,
    commandLeaseToken: leaseToken,
    commandExecutionGeneration: 1,
    observation: "authoritative_provider_retrieval" as const,
    values: {
      ...commandValues,
      cancel_at_period_end: true,
      canceled_at: new Date(),
      provider_object_digest: "d".repeat(64),
    },
  };
  return {
    organizationId,
    subscriptionId,
    commandId,
    leaseToken,
    eventId,
    eventTime,
    webhookValues,
    input,
  };
}
async function lease(f: Awaited<ReturnType<typeof fixture>>) {
  // This fixture seeds an owned provider attempt to isolate the authority seam;
  // actual claim/dispatch ownership is covered by the cancellation consumer tests.
  await client
    .getPgliteClientForTests()
    .query(
      `UPDATE billing_subscription_commands SET status='OUTCOME_UNKNOWN',state_revision=2,execution_generation=1,provider_started_at=clock_timestamp(),lease_token=$2,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1`,
      [f.commandId, f.leaseToken],
    );
}
test("command publication preserves webhook watermark without reusing its immutable event revision", async () => {
  const f = await fixture();
  await lease(f);
  const published = await writeTransaction(async (tx) => {
    const result = await authority.advanceCommandInTransaction(tx, f.input);
    await entitlements.rebuildInTransaction(tx, {
      organizationId: f.organizationId,
      sourceSubscriptionId: f.subscriptionId,
      sourceSubscriptionRevision: result.subscription.lifecycle_revision,
      expectedProjectionRevision: 1,
    });
    return result;
  });
  expect(published.subscription).toMatchObject({
    lifecycle_revision: 3,
    cancel_at_period_end: true,
    last_provider_event_id: f.eventId,
    last_provider_event_created_at: f.eventTime,
  });
  expect(published.revision).toMatchObject({
    revision: 3,
    source: "reconciliation",
    provider_event_id: null,
    provider_event_created_at: null,
    cancel_at_period_end: true,
  });
  expect((await entitlements.find(f.organizationId))?.source_subscription_revision).toBe(3);
  const oldReplay = await authority.advance({
    organizationId: f.organizationId,
    subscriptionId: f.subscriptionId,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: f.webhookValues,
  });
  expect(oldReplay).toMatchObject({
    replayed: true,
    revision: { revision: 2 },
    subscription: { lifecycle_revision: 3, cancel_at_period_end: true },
  });
  expect(await authority.listRevisions(f.organizationId, f.subscriptionId)).toHaveLength(3);
  await expect(
    writeTransaction((tx) => authority.advanceCommandInTransaction(tx, f.input)),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
});
test("unowned or expired command lease cannot publish a lifecycle revision", async () => {
  const f = await fixture();
  await lease(f);
  await expect(
    writeTransaction((tx) =>
      authority.advanceCommandInTransaction(tx, { ...f.input, commandLeaseToken: randomUUID() }),
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [f.commandId],
    );
  await expect(
    writeTransaction((tx) => authority.advanceCommandInTransaction(tx, f.input)),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_AUTHORITY_CONFLICT" });
  expect(await authority.listRevisions(f.organizationId, f.subscriptionId)).toHaveLength(2);
});
test("legacy command helpers cannot confer cancellation dispatch or publish its result", async () => {
  const f = await fixture();
  expect(
    await operations.markCommandOutcomeUnknown({
      organizationId: f.organizationId,
      commandId: f.commandId,
      expectedStateRevision: 1,
      expectedExecutionGeneration: 0,
    }),
  ).toBeNull();
  expect((await operations.findCommand(f.organizationId, f.commandId))?.status).toBe("PREPARED");
  await lease(f);
  expect(
    await operations.resolveCommandOutcome({
      organizationId: f.organizationId,
      commandId: f.commandId,
      expectedStateRevision: 2,
      expectedExecutionGeneration: 1,
      outcome: "SUCCEEDED",
      providerResponseDigest: "d".repeat(64),
      errorCode: null,
    }),
  ).toBeNull();
  await writeTransaction((tx) => authority.advanceCommandInTransaction(tx, f.input));
  await client
    .getPgliteClientForTests()
    .query(
      `UPDATE billing_subscription_commands SET status='APPLIED',state_revision=3,provider_response_digest=$2,completed_at=clock_timestamp(),applied_at=clock_timestamp(),result_subscription_id=$3,result_subscription_revision=3 WHERE id=$1`,
      [f.commandId, "d".repeat(64), f.subscriptionId],
    );
  expect(
    await operations.applyCheckoutResult({
      organizationId: f.organizationId,
      commandId: f.commandId,
      resultSubscriptionId: f.subscriptionId,
      expectedStateRevision: 2,
    }),
  ).toBeNull();
  expect((await operations.findCommand(f.organizationId, f.commandId))?.status).toBe("APPLIED");
});
