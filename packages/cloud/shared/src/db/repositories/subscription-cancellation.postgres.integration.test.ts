/** Exercises cancellation single-flight and post-lock publication fences using independent PostgreSQL sessions and the actual migrated repository. No provider request is made. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { installOrganizationUpgradeTestSchema } from "./organization-upgrade-test-fixture";
import { seedCancellationTestAccount } from "./subscription-cancellation-test-fixture";

const url = process.env.SUBSCRIPTION_AUTHORITY_POSTGRES_URL;
const schema = `cancellation_${randomUUID().replaceAll("-", "_")}`;
let setup: Client;
let repo: typeof import("./subscription-cancellation");
let close: typeof import("../client").closeDatabaseConnectionsForTests;
async function connect() {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET search_path TO ${schema},public`);
  return client;
}
async function seed() {
  return seedCancellationTestAccount((text, values) => setup.query(text, values));
}
async function waitForPublicationLock() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const waiting = await setup.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query ILIKE '%organizations%FOR UPDATE%'",
      [schema],
    );
    if (waiting.rows.length > 0) return;
    await Bun.sleep(20);
  }
  throw new Error("Actual cancellation transaction did not wait on organization lock");
}
(url ? describe : describe.skip)("cancellation PostgreSQL transaction authority", () => {
  beforeAll(async () => {
    setup = new Client({ connectionString: url });
    await setup.connect();
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema},public`);
    await installOrganizationUpgradeTestSchema((query) => setup.query(query));
    const target = new URL(url!);
    target.searchParams.set("options", `-c search_path=${schema},public`);
    target.searchParams.set("application_name", schema);
    process.env.DATABASE_URL = target.toString();
    process.env.TEST_DATABASE_URL = target.toString();
    process.env.LOCAL_PG_POOL_MAX = "4";
    process.env.ENVIRONMENT = "local";
    process.env.STRIPE_SECRET_KEY = "sk_test_pgfixture";
    process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
    process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
    process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
    process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
    repo = await import("./subscription-cancellation");
    ({ closeDatabaseConnectionsForTests: close } = await import("../client"));
  }, 120_000);
  afterAll(async () => {
    if (!setup) return;
    await close?.();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`);
    await setup.end();
  });
  test("plan review captures current authority without admitting a command", async () => {
    const f = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    const captured = await readOrganizationPlanChangeSource(f.input);
    expect(captured.source.id).toBe(f.input.subscriptionId);
    expect(captured.organizationCustomerId).toBe(f.source.stripe_customer_id);
    const rows = await setup.query(
      "SELECT id FROM billing_subscription_commands WHERE organization_id=$1",
      [f.input.organizationId],
    );
    expect(rows.rowCount).toBe(0);
  });
  test("plan review rejects foreign actors, stale revisions and missing projections", async () => {
    const f = await seed();
    const other = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await expect(
      readOrganizationPlanChangeSource({ ...f.input, actorId: other.input.actorId }),
    ).rejects.toThrow();
    await expect(
      readOrganizationPlanChangeSource({ ...f.input, expectedSubscriptionRevision: 2 }),
    ).rejects.toThrow();
    await setup.query("DELETE FROM organization_entitlements WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
    await expect(readOrganizationPlanChangeSource(f.input)).rejects.toThrow();
  });
  test("plan review rejects an admitted cancellation before provider dispatch", async () => {
    const f = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    await repo.prepareCancellation(f.input);
    await expect(readOrganizationPlanChangeSource(f.input)).rejects.toThrow();
  });
  test("plan review rechecks actor revocation after waiting for the organization lock", async () => {
    const f = await seed();
    const { readOrganizationPlanChangeSource } = await import("./organization-plan-change");
    const holder = await connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = readOrganizationPlanChangeSource(f.input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForPublicationLock();
      await holder.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { code: "SUBSCRIPTION_PLAN_CHANGE_FORBIDDEN" },
      });
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
  async function reviewedUndo() {
    const f = await seed();
    const cancel = await repo.prepareCancellation(f.input);
    const cancellationClaim = await repo.claimCancellation({ ...f.input, commandId: cancel.id });
    if (!cancellationClaim) throw new Error("Missing cancellation fixture claim");
    await repo.finalizeCancellation(f.input, cancellationClaim, {
      ...f.provider,
      cancel_at_period_end: true,
      cancel_at: f.provider.current_period_end,
      canceled_at: Math.floor(Date.now() / 1000),
    });
    const input = { ...f.input, expectedSubscriptionRevision: 2, idempotencyKey: randomUUID() };
    const renewalAt = f.source.current_period_end.toISOString();
    const observedAt = Date.now();
    const review: import("../../lib/services/subscription-renewal-review-contract").SubscriptionRenewalReview =
      {
        kind: "renewal_estimate",
        subscriptionId: input.subscriptionId,
        expectedSubscriptionRevision: "2",
        planKey: "plus_monthly",
        catalogVersion: "v1",
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        baseAmountCents: 3000,
        renewalAt,
        nextPeriodEnd: new Date(
          f.source.current_period_end.getTime() + 30 * 86400000,
        ).toISOString(),
        subtotalCents: 3000,
        discountCents: 0,
        taxCents: 0,
        totalCents: 3000,
        startingBalanceCents: 0,
        amountDueCents: 3000,
        observedAt: new Date(observedAt).toISOString(),
        expiresAt: new Date(observedAt + 60000).toISOString(),
        termsDigest: "a".repeat(64),
      };
    const command = await repo.prepareCancellation({ ...input, renewalReview: review }, "resume");
    const claim = await repo.claimCancellation({ ...input, commandId: command.id }, "resume");
    if (!claim) throw new Error("Missing reviewed undo claim");
    return { input, command, claim };
  }
  test("review rejection and dispatch fence serialize to mutually exclusive outcomes", async () => {
    const f = await reviewedUndo();
    const [dispatch, rejection] = await Promise.allSettled([
      repo.assertCancellationClaimCurrent(f.input, f.claim, true),
      repo.failReviewedCancellationBeforeDispatch(f.input, f.claim),
    ]);
    expect(rejection.status).toBe("fulfilled");
    const row = (
      await setup.query(
        "SELECT status,cancellation_dispatch_state FROM billing_subscription_commands WHERE id=$1",
        [f.command.id],
      )
    ).rows[0];
    if (dispatch.status === "fulfilled") {
      expect(rejection).toMatchObject({ status: "fulfilled", value: false });
      expect(row).toEqual({ status: "OUTCOME_UNKNOWN", cancellation_dispatch_state: "started" });
    } else {
      expect(rejection).toMatchObject({ status: "fulfilled", value: true });
      expect(row).toEqual({ status: "FAILED", cancellation_dispatch_state: "ready" });
    }
  });
  test("review rejection waiting on the authority lock cannot consume an expired lease", async () => {
    const f = await reviewedUndo();
    const holder = await connect();
    let pending: Promise<boolean> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = repo.failReviewedCancellationBeforeDispatch(f.input, f.claim);
      await waitForPublicationLock();
      await setup.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [f.command.id],
      );
      await holder.query("COMMIT");
      expect(await pending).toBe(false);
      expect(
        (await repo.readCancellation({ ...f.input, commandId: f.command.id }, "resume")).status,
      ).toBe("OUTCOME_UNKNOWN");
    } finally {
      await holder.query("ROLLBACK");
      await pending?.catch(() => {});
      await holder.end();
    }
  });
  test("concurrent independent preparations yield one durable command and one conflicting intent", async () => {
    const f = await seed();
    const settled = await Promise.allSettled([
      repo.prepareCancellation(f.input),
      repo.prepareCancellation({ ...f.input, idempotencyKey: randomUUID() }),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      (
        await setup.query(
          "SELECT count(*)::int AS count FROM billing_subscription_commands WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  test("lease expiry while actual finalization waits on organization lock prevents all publication", async () => {
    const f = await seed();
    const command = await repo.prepareCancellation(f.input);
    const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
    const provider = {
      ...f.provider,
      cancel_at_period_end: true,
      cancel_at: f.provider.current_period_end,
      canceled_at: Math.floor(Date.now() / 1000),
    };
    const holder = await connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = repo.finalizeCancellation(f.input, claim!, provider).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForPublicationLock();
      await holder.query(
        "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [command.id],
      );
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { code: "SUBSCRIPTION_CANCELLATION_CONFLICT" },
      });
      expect(
        (
          await setup.query(
            "SELECT lifecycle_revision::int,cancel_at_period_end FROM billing_subscriptions WHERE id=$1",
            [f.input.subscriptionId],
          )
        ).rows,
      ).toEqual([{ lifecycle_revision: 1, cancel_at_period_end: false }]);
      expect(
        (
          await setup.query(
            "SELECT source_subscription_revision::int FROM organization_entitlements WHERE organization_id=$1",
            [f.input.organizationId],
          )
        ).rows,
      ).toEqual([{ source_subscription_revision: 1 }]);
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
  test("primary actor revocation committed ahead of finalization blocks the command result", async () => {
    const f = await seed();
    const command = await repo.prepareCancellation(f.input);
    const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
    const holder = await connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = repo
        .finalizeCancellation(f.input, claim!, {
          ...f.provider,
          cancel_at_period_end: true,
          canceled_at: Math.floor(Date.now() / 1000),
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await waitForPublicationLock();
      await holder.query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({
        error: { code: "SUBSCRIPTION_CANCELLATION_FORBIDDEN" },
      });
      expect(
        (
          await setup.query(
            "SELECT status,result_subscription_revision FROM billing_subscription_commands WHERE id=$1",
            [command.id],
          )
        ).rows,
      ).toEqual([{ status: "OUTCOME_UNKNOWN", result_subscription_revision: null }]);
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
  test("scheduled webhook waiting on organization lock cannot publish after its receipt lease expires", async () => {
    const f = await seed();
    const command = await repo.prepareCancellation(f.input);
    const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
    if (!claim) throw new Error("Expected real cancellation lease");
    const provider = {
      ...f.provider,
      cancel_at_period_end: true,
      cancel_at: f.provider.current_period_end,
      canceled_at: Math.floor(Date.now() / 1000),
    };
    await repo.finalizeCancellation(f.input, claim, provider);
    const { subscriptionBillingOperationsRepository: operations } = await import(
      "./subscription-billing-operations"
    );
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const eventCreatedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
    const receipt = await operations.recordEvent({
      organizationId: f.input.organizationId,
      subscriptionId: f.input.subscriptionId,
      providerEventId: eventId,
      eventType: "customer.subscription.updated",
      providerObjectType: "subscription",
      providerObjectId: f.source.stripe_subscription_id,
      livemode: false,
      eventCreatedAt,
      payloadDigest: "e".repeat(64),
      now: new Date(),
    });
    const leaseToken = randomUUID();
    expect(
      await operations.claimEvent({
        organizationId: f.input.organizationId,
        receiptId: receipt.value.id,
        leaseToken,
        leaseDurationMs: 60000,
      }),
    ).not.toBeNull();
    const projection = await setup.query<{ projection_revision: string }>(
      "SELECT projection_revision FROM organization_entitlements WHERE organization_id=$1",
      [f.input.organizationId],
    );
    const snapshot = async () => ({
      source: (
        await setup.query("SELECT * FROM billing_subscriptions WHERE id=$1", [
          f.input.subscriptionId,
        ])
      ).rows,
      journal: (
        await setup.query(
          "SELECT * FROM billing_subscription_revisions WHERE subscription_id=$1 ORDER BY revision",
          [f.input.subscriptionId],
        )
      ).rows,
      projection: (
        await setup.query("SELECT * FROM organization_entitlements WHERE organization_id=$1", [
          f.input.organizationId,
        ])
      ).rows,
      authority: (
        await setup.query(
          "SELECT * FROM organization_subscription_authorities WHERE organization_id=$1",
          [f.input.organizationId],
        )
      ).rows,
      audit: (
        await setup.query(
          "SELECT * FROM organization_policy_audit WHERE organization_id=$1 ORDER BY id",
          [f.input.organizationId],
        )
      ).rows,
      receipt: (
        await setup.query(
          "SELECT status,disposition,applied_subscription_revision,lease_token FROM billing_subscription_event_receipts WHERE id=$1",
          [receipt.value.id],
        )
      ).rows,
    });
    const before = await snapshot();
    const holder = await connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM organizations WHERE id=$1 FOR UPDATE", [
        f.input.organizationId,
      ]);
      pending = operations
        .finalizeCancellationEvent({
          organizationId: f.input.organizationId,
          subscriptionId: f.input.subscriptionId,
          commandId: command.id,
          receiptId: receipt.value.id,
          leaseToken,
          expectedSubscriptionRevision: 2,
          expectedProjectionRevision: Number(projection.rows[0]!.projection_revision),
          providerEventId: eventId,
          eventCreatedAt,
          raw: provider,
          customer: { id: f.source.stripe_customer_id, object: "customer", livemode: false },
        })
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      await waitForPublicationLock();
      await holder.query(
        "UPDATE billing_subscription_event_receipts SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [receipt.value.id],
      );
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ error: { code: "SUBSCRIPTION_LIFECYCLE_LEASE_LOST" } });
      expect(await snapshot()).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      await pending;
      await holder.end();
    }
  });
  test("tenant-set erasure removes a real cancel undo cancel predecessor chain and retention failure rolls back", async () => {
    const f = await seed();
    let revision = 1;
    let preceding: string | null = null;
    for (const kind of ["cancel", "resume", "cancel"] as const) {
      const input = {
        ...f.input,
        expectedSubscriptionRevision: revision,
        idempotencyKey: randomUUID(),
      };
      const command = await repo.prepareCancellation(input, kind);
      expect(command.schedule_predecessor_command_id).toBe(preceding);
      const claim = await repo.claimCancellation({ ...input, commandId: command.id }, kind);
      await repo.finalizeCancellation(input, claim!, {
        ...f.provider,
        cancel_at_period_end: kind === "cancel",
        cancel_at: kind === "cancel" ? f.provider.current_period_end : null,
        canceled_at: kind === "cancel" ? Math.floor(Date.now() / 1000) : null,
      });
      revision++;
      preceding = command.id;
    }
    const before = (
      await setup.query(
        "SELECT * FROM billing_subscription_commands WHERE organization_id=$1 ORDER BY result_subscription_revision",
        [f.input.organizationId],
      )
    ).rows;
    await setup.query(
      "CREATE TABLE cancellation_command_retention(command_id uuid REFERENCES billing_subscription_commands(id) ON DELETE RESTRICT)",
    );
    await setup.query("INSERT INTO cancellation_command_retention VALUES($1)", [preceding]);
    await expect(
      setup.query("DELETE FROM billing_subscription_commands WHERE organization_id=$1", [
        f.input.organizationId,
      ]),
    ).rejects.toThrow();
    expect(
      (
        await setup.query(
          "SELECT * FROM billing_subscription_commands WHERE organization_id=$1 ORDER BY result_subscription_revision",
          [f.input.organizationId],
        )
      ).rows,
    ).toEqual(before);
    await setup.query("DROP TABLE cancellation_command_retention");
    await setup.query("DELETE FROM billing_subscription_commands WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
    expect(
      (
        await setup.query("SELECT id FROM billing_subscription_commands WHERE organization_id=$1", [
          f.input.organizationId,
        ])
      ).rows,
    ).toEqual([]);
  });
});
