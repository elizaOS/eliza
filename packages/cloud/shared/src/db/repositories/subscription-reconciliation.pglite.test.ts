/** Exercises missed-event recovery through actual migrated primary transactions and the real Stripe SDK against controlled loopback HTTP; no live provider evidence is claimed. */
import { afterAll, beforeAll, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.NODE_ENV = "test";
process.env.CLOUD_E2E = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(120_000);
let client: typeof import("../client"),
  repo: typeof import("./subscription-reconciliation"),
  service: typeof import("../../lib/services/subscription-reconciliation");
let provider: object;
let writes = 0;
let stallCustomer = false;
let stalledRequestClosed = false;
const requests: string[] = [];
const server = createServer((request, response) => {
  requests.push(`${request.method} ${request.url}`);
  if (request.method !== "GET") writes++;
  response.setHeader("Content-Type", "application/json");
  if (stallCustomer && request.url?.startsWith("/v1/customers/")) {
    request.socket.once("close", () => {
      stalledRequestClosed = true;
    });
    response.writeHead(200);
    response.flushHeaders();
    response.write("{");
    return;
  }
  if (request.url?.startsWith("/v1/customers/"))
    response.end(
      JSON.stringify({ id: request.url.split("/").at(-1), object: "customer", livemode: false }),
    );
  else response.end(JSON.stringify(provider));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback address missing");
  process.env.STRIPE_CLOUD_E2E_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  client = await import("../client");
  await installCancellationTestSchema((query) => client.getPgliteClientForTests().exec(query));
  const migration = await readFile(
    new URL("../migrations/0385_subscription_reconciliation.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint"))
    if (statement.trim()) await client.getPgliteClientForTests().exec(statement);
  repo = await import("./subscription-reconciliation");
  service = await import("../../lib/services/subscription-reconciliation");
});
beforeEach(async () => {
  await client.getPgliteClientForTests().exec("UPDATE organizations SET is_active=false");
  requests.length = 0;
  writes = 0;
  stallCustomer = false;
  stalledRequestClosed = false;
});
afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
  await client.closeDatabaseConnectionsForTests();
});
async function fixture() {
  const f = await seedCancellationTestAccount();
  provider = {
    ...f.provider,
    status: "canceled",
    canceled_at: Math.floor(Date.now() / 1000),
    ended_at: Math.floor(Date.now() / 1000),
  };
  return f;
}
async function readback(id: string) {
  return (
    await client.getPgliteClientForTests().query(
      `SELECT s.lifecycle_revision,s.status,s.last_provider_event_id,s.last_provider_event_created_at,e.projection_revision,e.source_subscription_revision,a.policy_generation,
    (SELECT count(*)::int FROM organization_policy_audit WHERE organization_id=s.organization_id) audits,
    (SELECT count(*)::int FROM subscription_notice_intents WHERE organization_id=s.organization_id) notices,
    (SELECT count(*)::int FROM billing_subscription_revisions WHERE subscription_id=s.id) revisions
    FROM billing_subscriptions s JOIN organization_entitlements e ON e.organization_id=s.organization_id JOIN organization_subscription_authorities a ON a.organization_id=s.organization_id WHERE s.id=$1`,
      [id],
    )
  ).rows;
}
test("actual SDK recovery publishes terminal once and repeated observation creates only a no-change receipt", async () => {
  const f = await fixture();
  const policyReader = await import("../../lib/services/organization-quota-policy");
  const admission = await import("../../lib/services/organization-policy-admission");
  const oldPolicy = await policyReader.readOrganizationQuotaPolicy(f.input.organizationId);
  const result = await service.recoverMissedSubscriptionEvents();
  expect({
    status: result.status,
    requests,
    receipts: (
      await client
        .getPgliteClientForTests()
        .query("SELECT reason FROM subscription_reconciliation_attempts WHERE organization_id=$1", [
          f.input.organizationId,
        ])
    ).rows,
  }).toMatchObject({ status: "ok" });
  expect(result.attempts[0]?.disposition).toBe("applied");
  expect(writes).toBe(0);
  expect(requests).toEqual([
    `GET /v1/customers/${f.source.stripe_customer_id}`,
    `GET /v1/subscriptions/${f.source.stripe_subscription_id}`,
  ]);
  let admitted = 0;
  await expect(
    admission.withOrganizationPolicyAdmission(
      f.input.organizationId,
      oldPolicy.authority,
      async () => {
        admitted++;
      },
    ),
  ).rejects.toMatchObject({ code: "ORGANIZATION_POLICY_STALE" });
  expect(admitted).toBe(0);
  const currentPolicy = await policyReader.readOrganizationQuotaPolicy(f.input.organizationId);
  expect(currentPolicy.subscriptionFunded).toBe(false);
  await admission.withOrganizationPolicyAdmission(
    f.input.organizationId,
    currentPolicy.authority,
    async () => {
      admitted++;
    },
  );
  expect(admitted).toBe(1);
  const after = await readback(f.input.subscriptionId);
  expect(after[0]).toMatchObject({
    status: "canceled",
    lifecycle_revision: 2,
    source_subscription_revision: 2,
    notices: 1,
    revisions: 2,
    last_provider_event_id: null,
    last_provider_event_created_at: null,
  });
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE subscription_reconciliation_scans SET next_due_at=now()-interval '1 second' WHERE organization_id=$1",
      [f.input.organizationId],
    );
  provider = { ...provider, unrelated_metadata: "changed" };
  expect((await service.recoverMissedSubscriptionEvents()).attempts[0]?.disposition).toBe(
    "no_change",
  );
  expect(await readback(f.input.subscriptionId)).toEqual(after);
});
test("notice failure rolls source, journal, projection, generation and audit back while retaining retry failure", async () => {
  const f = await fixture();
  const before = await readback(f.input.subscriptionId);
  await client
    .getPgliteClientForTests()
    .exec(
      `CREATE FUNCTION reject_recovery_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected notice failure'; END $$; CREATE TRIGGER fail_recovery_notice BEFORE INSERT ON subscription_notice_intents FOR EACH ROW EXECUTE FUNCTION reject_recovery_notice();`,
    );
  try {
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.status).toBe("degraded");
    expect(result.attempts[0]?.disposition).toBe("unavailable");
    expect(await readback(f.input.subscriptionId)).toEqual(before);
    expect(
      (
        await client
          .getPgliteClientForTests()
          .query<{ failures: number; future: boolean }>(
            "SELECT failures,next_due_at>clock_timestamp() AS future FROM subscription_reconciliation_scans WHERE organization_id=$1",
            [f.input.organizationId],
          )
      ).rows[0],
    ).toEqual({ failures: 1, future: true });
  } finally {
    await client
      .getPgliteClientForTests()
      .exec(
        "DROP TRIGGER fail_recovery_notice ON subscription_notice_intents; DROP FUNCTION reject_recovery_notice()",
      );
  }
});
test("claims are singleflight and old identity cannot complete another generation", async () => {
  const f = await fixture();
  const claim = await repo.claimSubscriptionReconciliation(f.input);
  expect(claim).not.toBeNull();
  expect(await repo.claimSubscriptionReconciliation(f.input)).toBeNull();
  if (!claim) throw new Error("Missing claim");
  await expect(
    repo.failSubscriptionReconciliation(
      { ...claim, leaseToken: crypto.randomUUID() },
      "unavailable",
      "probe",
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_RECONCILIATION_IDENTITY_MISMATCH" });
  const receipt = await repo.failSubscriptionReconciliation(
    claim,
    "unavailable",
    "provider_unavailable",
  );
  expect(receipt.reason).toBe("provider_unavailable");
  expect(await repo.listDueSubscriptionReconciliations(5)).toEqual([]);
});
test("fenced accounts do not occupy eligible candidate slots and every unsupported claimed source rotates", async () => {
  for (let i = 0; i < 6; i++) {
    const f = await fixture();
    await client
      .getPgliteClientForTests()
      .query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [
        f.input.organizationId,
      ]);
  }
  const f = await fixture();
  provider = { ...f.provider, status: "past_due" };
  expect(await repo.listDueSubscriptionReconciliations(5)).toEqual([
    { organizationId: f.input.organizationId, subscriptionId: f.input.subscriptionId },
  ]);
  const result = await service.recoverMissedSubscriptionEvents();
  expect(result.status).toBe("degraded");
  expect(await repo.listDueSubscriptionReconciliations(5)).toEqual([]);
  expect((await readback(f.input.subscriptionId))[0]).toMatchObject({
    status: "active",
    lifecycle_revision: 1,
  });
});

test("late authentic terminal queue event applies only its receipt and replay preserves reconciled watermark", async () => {
  const f = await fixture();
  const authority = (await import("./subscription-authority")).subscriptionAuthorityRepository;
  const entitlements = (await import("./subscription-entitlements"))
    .subscriptionEntitlementsRepository;
  const epoch = Math.floor(Date.now() / 1000);
  await authority.advance({
    organizationId: f.input.organizationId,
    subscriptionId: f.input.subscriptionId,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...f.source,
      last_provider_event_id: "evt_originalwatermark",
      last_provider_event_created_at: new Date(epoch * 1000),
    },
  });
  await entitlements.rebuild({
    organizationId: f.input.organizationId,
    sourceSubscriptionId: f.input.subscriptionId,
    sourceSubscriptionRevision: 2,
    expectedProjectionRevision: 1,
  });
  expect((await service.recoverMissedSubscriptionEvents()).attempts[0]?.disposition).toBe(
    "applied",
  );
  const after = await readback(f.input.subscriptionId);
  expect(after[0]).toMatchObject({
    lifecycle_revision: 3,
    last_provider_event_id: "evt_originalwatermark",
    last_provider_event_created_at: new Date(epoch * 1000),
  });
  const queue = await import("../../../../api/src/queue/stripe-event");
  function message(id: string, created: number) {
    const event: import("stripe").default.CustomerSubscriptionDeletedEvent = JSON.parse(
      JSON.stringify({
        id,
        object: "event",
        type: "customer.subscription.deleted",
        livemode: false,
        created,
        data: { object: provider },
        api_version: "2024-11-20.acacia",
        pending_webhooks: 1,
        request: null,
      }),
    );
    return {
      body: {
        kind: "stripe.event" as const,
        eventId: id,
        eventType: event.type,
        event,
        receivedAt: Date.now(),
      },
      attempts: 1,
    };
  }
  const delivery = message("evt_latecanonical", epoch + 1);
  await queue.processStripeEvent(delivery);
  await queue.processStripeEvent(delivery);
  expect(await readback(f.input.subscriptionId)).toEqual(after);
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query<{ status: string; applied_subscription_revision: number }>(
          "SELECT status,applied_subscription_revision FROM billing_subscription_event_receipts WHERE provider_event_id='evt_latecanonical'",
        )
    ).rows[0],
  ).toEqual({ status: "applied", applied_subscription_revision: 3 });
  expect(await queue.processStripeEvent(message("evt_olderunseen", epoch - 1))).toBe("retry");
  expect(await readback(f.input.subscriptionId)).toEqual(after);
});

test("provider failure and failed receipt bookkeeping preserve both causes", async () => {
  const f = await fixture();
  provider = { ...f.provider, status: "past_due" };
  await client
    .getPgliteClientForTests()
    .exec(
      `CREATE FUNCTION reject_recovery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.disposition<>'processing' THEN RAISE EXCEPTION 'injected receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_recovery_receipt BEFORE UPDATE ON subscription_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION reject_recovery_receipt();`,
    );
  try {
    let caught: unknown;
    try {
      await service.recoverMissedSubscriptionEvents();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "SUBSCRIPTION_RECONCILIATION_BOOKKEEPING_FAILED" });
    if (!(caught instanceof Error) || !(caught.cause instanceof AggregateError))
      throw new Error("Missing retained causes");
    expect(caught.cause.errors).toHaveLength(2);
    expect(caught.cause.errors[0]).toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
    expect(caught.cause.errors[1]).toMatchObject({
      cause: { message: "injected receipt failure" },
    });
    expect((await readback(f.input.subscriptionId))[0]).toMatchObject({
      status: "active",
      lifecycle_revision: 1,
    });
  } finally {
    await client
      .getPgliteClientForTests()
      .exec(
        "DROP TRIGGER fail_recovery_receipt ON subscription_reconciliation_attempts; DROP FUNCTION reject_recovery_receipt()",
      );
  }
});

test("owned active schedule is observed without another command effect or policy publication", async () => {
  const f = await fixture();
  const cancellation = await import("./subscription-cancellation");
  const command = await cancellation.prepareCancellation(f.input);
  const claim = await cancellation.claimCancellation({ ...f.input, commandId: command.id });
  if (!claim) throw new Error("Cancellation claim missing");
  provider = {
    ...f.provider,
    cancel_at_period_end: true,
    cancel_at: f.provider.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  };
  await cancellation.finalizeCancellation(f.input, claim, provider);
  const before = await readback(f.input.subscriptionId);
  const result = await service.recoverMissedSubscriptionEvents();
  expect(result.attempts[0]?.disposition).toBe("no_change");
  expect(await readback(f.input.subscriptionId)).toEqual(before);
  expect(writes).toBe(0);
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE organization_entitlements SET completions_rpm=completions_rpm+1 WHERE organization_id=$1",
      [f.input.organizationId],
    );
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
      [f.input.organizationId],
    );
  expect((await service.recoverMissedSubscriptionEvents()).attempts[0]?.disposition).toBe(
    "unavailable",
  );
  expect(writes).toBe(0);
});

test("completed receipt replay requires its original observation and source identity", async () => {
  const f = await fixture();
  const claim = await repo.claimSubscriptionReconciliation(f.input);
  if (!claim) throw new Error("Missing claim");
  const value = {
    ...f.source,
    status: "canceled",
    canceled_at: new Date(),
    ended_at: new Date(),
    provider_object_digest: "b".repeat(64),
  };
  const {
    last_provider_event_id: _id,
    last_provider_event_created_at: _time,
    ...observation
  } = value;
  const receipt = await repo.finalizeSubscriptionReconciliation(claim, {
    kind: "terminal",
    value: observation,
  });
  const before = await readback(f.input.subscriptionId);
  expect(
    await repo.finalizeSubscriptionReconciliation(claim, {
      kind: "terminal",
      value: { ...observation, provider_object_digest: "c".repeat(64) },
    }),
  ).toEqual(receipt);
  await expect(
    repo.finalizeSubscriptionReconciliation(claim, {
      kind: "terminal",
      value: { ...observation, ended_at: new Date(observation.ended_at.getTime() + 1000) },
    }),
  ).rejects.toThrow();
  await expect(
    repo.finalizeSubscriptionReconciliation(
      { ...claim, identityDigest: "d".repeat(64) },
      { kind: "terminal", value: observation },
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_RECONCILIATION_IDENTITY_MISMATCH" });
  expect(await readback(f.input.subscriptionId)).toEqual(before);
});

test("source changes after provider capture invalidate publication without adopting a refreshed CAS", async () => {
  const f = await fixture();
  const claim = await repo.claimSubscriptionReconciliation(f.input);
  if (!claim) throw new Error("Missing claim");
  const authority = (await import("./subscription-authority")).subscriptionAuthorityRepository;
  await authority.advance({
    organizationId: f.input.organizationId,
    subscriptionId: f.input.subscriptionId,
    expectedRevision: 1,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...f.source,
      last_provider_event_id: "evt_concurrentchange",
      last_provider_event_created_at: new Date(),
    },
  });
  const before = await readback(f.input.subscriptionId);
  const {
    last_provider_event_id: _id,
    last_provider_event_created_at: _time,
    ...values
  } = f.source;
  const receipt = await repo.finalizeSubscriptionReconciliation(claim, {
    kind: "terminal",
    value: { ...values, status: "canceled", canceled_at: new Date(), ended_at: new Date() },
  });
  expect(receipt.disposition).toBe("stale");
  expect(await readback(f.input.subscriptionId)).toEqual(before);
});

for (const corruption of ["missing", "stale", "corrupt"] as const)
  test(`terminal scanner and late real event do not acknowledge ${corruption} projection`, async () => {
    const f = await fixture();
    expect((await service.recoverMissedSubscriptionEvents()).attempts[0]?.disposition).toBe(
      "applied",
    );
    const database = client.getPgliteClientForTests();
    if (corruption === "missing")
      await database.query("DELETE FROM organization_entitlements WHERE organization_id=$1", [
        f.input.organizationId,
      ]);
    else if (corruption === "stale")
      await database.query(
        "UPDATE organization_entitlements SET source_subscription_revision=1 WHERE organization_id=$1",
        [f.input.organizationId],
      );
    else
      await database.query(
        "UPDATE organization_entitlements SET completions_rpm=completions_rpm+1 WHERE organization_id=$1",
        [f.input.organizationId],
      );
    const before = await readback(f.input.subscriptionId);
    await database.query(
      "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
      [f.input.organizationId],
    );
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.status).toBe("degraded");
    expect(result.attempts[0]?.disposition).toBe("unavailable");
    const event: import("stripe").default.CustomerSubscriptionDeletedEvent = JSON.parse(
      JSON.stringify({
        id: `evt_projection${corruption}`,
        object: "event",
        type: "customer.subscription.deleted",
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: provider },
        api_version: "2024-11-20.acacia",
        pending_webhooks: 1,
        request: null,
      }),
    );
    const queue = await import("../../../../api/src/queue/stripe-event");
    expect(
      await queue.processStripeEvent({
        body: {
          kind: "stripe.event",
          eventId: event.id,
          eventType: event.type,
          event,
          receivedAt: Date.now(),
        },
        attempts: 1,
      }),
    ).toBe("retry");
    expect(await readback(f.input.subscriptionId)).toEqual(before);
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM billing_subscription_event_receipts WHERE provider_event_id=$1",
          [event.id],
        )
      ).rows[0]?.status,
    ).not.toBe("applied");
  });

test("actual scoped Stripe SDK owns body timeout, preserves typed cause and never retries", async () => {
  const f = await fixture();
  stallCustomer = true;
  const { createStripeRecoveryClient } = await import("../../lib/stripe");
  const stripe = createStripeRecoveryClient(Date.now() + 100);
  await expect(stripe.customers.retrieve(f.source.stripe_customer_id)).rejects.toMatchObject({
    type: "StripeConnectionError",
    detail: { code: "SUBSCRIPTION_RECOVERY_READ_TIMEOUT" },
  });
  for (let n = 0; n < 50 && !stalledRequestClosed; n++) await Bun.sleep(10);
  expect(stalledRequestClosed).toBe(true);
  expect(requests).toEqual([`GET /v1/customers/${f.source.stripe_customer_id}`]);
  expect(writes).toBe(0);
  await expect(
    createStripeRecoveryClient(Date.now() + 1000).subscriptions.update(
      f.source.stripe_subscription_id,
      { cancel_at_period_end: true },
    ),
  ).rejects.toMatchObject({
    type: "StripeConnectionError",
    detail: { code: "SUBSCRIPTION_RECOVERY_READ_ONLY" },
  });
  expect(writes).toBe(0);
});

test("a full failed batch durably rotates so the next eligible subscription is not starved", async () => {
  const fixtures = [];
  for (let n = 0; n < 6; n++) fixtures.push(await fixture());
  const candidates = await repo.listDueSubscriptionReconciliations(5);
  const deferred = fixtures.find(
    (f) => !candidates.some((candidate) => candidate.subscriptionId === f.input.subscriptionId),
  );
  if (!deferred) throw new Error("Missing deferred candidate");
  provider = { ...deferred.provider, status: "past_due" };
  const first = await service.recoverMissedSubscriptionEvents();
  expect(first.attempts).toHaveLength(5);
  expect(first.attempts.every((attempt) => attempt.disposition === "unavailable")).toBe(true);
  expect(await repo.listDueSubscriptionReconciliations(5)).toEqual([
    {
      organizationId: deferred.input.organizationId,
      subscriptionId: deferred.input.subscriptionId,
    },
  ]);
  const next = await service.recoverMissedSubscriptionEvents();
  expect(next.attempts).toHaveLength(1);
  expect(await repo.listDueSubscriptionReconciliations(5)).toEqual([]);
  expect(writes).toBe(0);
});

test("final receipt failure rolls back the already-written source, projection, generation, audit and notice", async () => {
  const f = await fixture();
  const before = await readback(f.input.subscriptionId);
  const database = client.getPgliteClientForTests();
  await database.exec(
    `CREATE FUNCTION reject_applied_recovery_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.disposition='applied' THEN RAISE EXCEPTION 'injected applied receipt failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_applied_recovery_receipt BEFORE UPDATE ON subscription_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION reject_applied_recovery_receipt();`,
  );
  try {
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.attempts[0]?.disposition).toBe("unavailable");
    expect(await readback(f.input.subscriptionId)).toEqual(before);
    expect(
      (
        await database.query<{ result_revision: number | null }>(
          "SELECT result_revision FROM subscription_reconciliation_attempts WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows,
    ).toEqual([{ result_revision: null }]);
  } finally {
    await database.exec(
      "DROP TRIGGER fail_applied_recovery_receipt ON subscription_reconciliation_attempts; DROP FUNCTION reject_applied_recovery_receipt()",
    );
  }
});

test("healthy unscheduled active subscriptions reconcile unchanged without commands or publication", async () => {
  const f = await fixture();
  provider = f.provider;
  const before = await readback(f.input.subscriptionId);
  for (let run = 0; run < 2; run++) {
    if (run > 0) {
      provider = { ...f.provider, metadata: { unrelated: "changed" } };
      await client
        .getPgliteClientForTests()
        .query(
          "UPDATE subscription_reconciliation_scans SET next_due_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
          [f.input.organizationId],
        );
    }
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.status).toBe("ok");
    expect(result.attempts[0]?.disposition).toBe("no_change");
    expect(await readback(f.input.subscriptionId)).toEqual(before);
  }
  expect(writes).toBe(0);
  expect(requests).toHaveLength(4);
  const receipt = await client
    .getPgliteClientForTests()
    .query(
      "SELECT disposition, observed_revision, result_revision FROM subscription_reconciliation_attempts WHERE organization_id=$1 ORDER BY generation",
      [f.input.organizationId],
    );
  expect(receipt.rows).toEqual([
    { disposition: "no_change", observed_revision: 1, result_revision: null },
    { disposition: "no_change", observed_revision: 1, result_revision: null },
  ]);
});

for (const corruption of [
  "missing_projection",
  "corrupt_projection",
  "source_journal_mismatch",
  "provider_schedule_drift",
] as const)
  test(`ordinary active no-change rejects ${corruption}`, async () => {
    const f = await fixture();
    provider = f.provider;
    const database = client.getPgliteClientForTests();
    if (corruption === "missing_projection")
      await database.query("DELETE FROM organization_entitlements WHERE organization_id=$1", [
        f.input.organizationId,
      ]);
    else if (corruption === "corrupt_projection")
      await database.query(
        "UPDATE organization_entitlements SET completions_rpm=completions_rpm+1 WHERE organization_id=$1",
        [f.input.organizationId],
      );
    else if (corruption === "source_journal_mismatch")
      await database.query(
        "UPDATE billing_subscriptions SET provider_object_digest=$1 WHERE id=$2",
        ["f".repeat(64), f.input.subscriptionId],
      );
    else
      provider = {
        ...f.provider,
        cancel_at_period_end: true,
        cancel_at: f.provider.current_period_end,
        canceled_at: Math.floor(Date.now() / 1000),
      };
    const before = await readback(f.input.subscriptionId);
    const result = await service.recoverMissedSubscriptionEvents();
    expect(result.status).toBe("degraded");
    expect(result.attempts[0]?.disposition).toBe(
      corruption === "provider_schedule_drift" ? "unsupported" : "unavailable",
    );
    expect(await readback(f.input.subscriptionId)).toEqual(before);
    expect(writes).toBe(0);
  });
