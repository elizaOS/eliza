/** Runs renewal review through primary authority transactions; the provider is a controlled read-only fixture. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "../../db/repositories/subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_renewalreview";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
let customer: unknown;
let subscription: unknown;
let preview: unknown;
let beforePreviewReturn = async () => {};
const customerRead = mock(async () => customer);
const subscriptionRead = mock(async () => subscription);
const previewRead = mock(async () => {
  await beforePreviewReturn();
  return preview;
});
let updateImpl = async (): Promise<unknown> => {
  throw new Error("Review must never mutate");
};
const update = mock(async (..._args: unknown[]) => updateImpl());
mock.module("../stripe", () => ({
  requireStripe: () => ({
    customers: { retrieve: customerRead },
    subscriptions: { retrieve: subscriptionRead, update },
    invoices: { createPreview: previewRead },
  }),
}));
let client: typeof import("../../db/client");
let repo: typeof import("../../db/repositories/subscription-cancellation");
let service: typeof import("./subscription-renewal-review");
let cancellation: typeof import("./subscription-cancellation");
beforeAll(async () => {
  client = await import("../../db/client");
  await installCancellationTestSchema((q) => client.getPgliteClientForTests().exec(q));
  repo = await import("../../db/repositories/subscription-cancellation");
  service = await import("./subscription-renewal-review");
  cancellation = await import("./subscription-cancellation");
}, 120_000);
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  mock.restore();
});

async function fixture() {
  beforePreviewReturn = async () => {};
  update.mockClear();
  updateImpl = async () => {
    throw new Error("Review must never mutate");
  };
  const f = await seedCancellationTestAccount();
  const command = await repo.prepareCancellation(f.input);
  const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
  const scheduled = {
    ...f.provider,
    cancel_at_period_end: true,
    cancel_at: f.provider.current_period_end,
    canceled_at: Math.floor(Date.now() / 1000),
  };
  subscription = scheduled;
  if (!claim) throw new Error("Missing fixture claim");
  await repo.finalizeCancellation(f.input, claim, subscription);
  customer = { id: f.source.stripe_customer_id, object: "customer", livemode: false };
  const invoice = {
    id: "upcoming_in_review",
    object: "invoice",
    status: "draft",
    livemode: false,
    customer: f.source.stripe_customer_id,
    subscription: f.source.stripe_subscription_id,
    currency: "usd",
    collection_method: "charge_automatically",
    on_behalf_of: null,
    transfer_data: null,
    application_fee_amount: null,
    automatic_tax: { enabled: true, status: "complete" },
    amount_due: 2640,
    subtotal: 3000,
    total: 3240,
    tax: 240,
    starting_balance: -600,
    total_discount_amounts: [],
    total_tax_amounts: [{ amount: 240, inclusive: false, tax_rate: "txr_fixture" }],
    lines: {
      has_more: false,
      data: [
        {
          type: "subscription",
          subscription: f.source.stripe_subscription_id,
          subscription_item: f.source.stripe_subscription_item_id,
          proration: false,
          currency: "usd",
          quantity: 1,
          amount: 3000,
          price: { id: "price_plus" },
          period: {
            start: f.provider.current_period_end,
            end: f.provider.current_period_end + 30 * 86400,
          },
        },
      ],
    },
  };
  preview = invoice;
  const input = { ...f.input, expectedSubscriptionRevision: 2 };
  const captured = await repo.readCancellationUndoReviewSource(input);
  return { ...f, input, invoice, captured, scheduled };
}
const session = async () => {};

test("review preserves tax, credit, catalog version and current scope without a new command or mutation", async () => {
  const f = await fixture();
  const result = await service.readOrganizationSubscriptionRenewalReview(f.input, session);
  expect(result).toMatchObject({
    kind: "renewal_estimate",
    subscriptionId: f.input.subscriptionId,
    expectedSubscriptionRevision: "2",
    catalogVersion: "v1",
    baseAmountCents: 3000,
    totalCents: 3240,
    taxCents: 240,
    startingBalanceCents: -600,
    amountDueCents: 2640,
  });
  expect(Date.parse(result.expiresAt) - Date.parse(result.observedAt)).toBe(60_000);
  expect(JSON.stringify(result)).not.toContain(f.source.stripe_customer_id);
  expect(JSON.stringify(result)).not.toContain(f.source.stripe_subscription_id);
  expect(previewRead.mock.calls.at(-1)).toEqual([
    {
      customer: f.source.stripe_customer_id,
      subscription: f.source.stripe_subscription_id,
      preview_mode: "next",
      subscription_details: { cancel_at_period_end: false, proration_behavior: "none" },
    },
  ]);
  expect(update).not.toHaveBeenCalled();
  const rows = await client
    .getPgliteClientForTests()
    .query("SELECT kind FROM billing_subscription_commands WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  expect(rows.rows).toEqual([{ kind: "cancel" }]);
});
test("term fingerprint changes for tax/credit drift but not a new observation time or invoice ID", async () => {
  const f = await fixture();
  const project = (raw: unknown, observedAt = new Date()) =>
    service.projectSubscriptionRenewalReview({
      source: f.captured.source,
      raw,
      environment: process.env,
      observedAt,
    });
  const first = project(f.invoice);
  expect(
    project({ ...f.invoice, id: "upcoming_in_another" }, new Date(Date.now() + 1000)).termsDigest,
  ).toBe(first.termsDigest);
  expect(project({ ...f.invoice, amount_due: 2740, starting_balance: -500 }).termsDigest).not.toBe(
    first.termsDigest,
  );
  expect(
    project({
      ...f.invoice,
      tax: 300,
      total: 3300,
      total_tax_amounts: [{ amount: 300, inclusive: false, tax_rate: "txr_fixture" }],
    }).termsDigest,
  ).not.toBe(first.termsDigest);
});
test("wrong tenant, actor and revision never reach the provider", async () => {
  const f = await fixture();
  for (const input of [
    { ...f.input, organizationId: randomUUID() },
    { ...f.input, actorId: randomUUID() },
    { ...f.input, expectedSubscriptionRevision: 1 },
  ]) {
    const count = customerRead.mock.calls.length;
    await expect(
      service.readOrganizationSubscriptionRenewalReview(input, session),
    ).rejects.toThrow();
    expect(customerRead.mock.calls.length).toBe(count);
  }
});
test("incomplete, cross-scope, unsupported-period and incomplete-tax previews fail closed", async () => {
  const f = await fixture();
  const line = f.invoice.lines.data[0]!;
  for (const raw of [
    { ...f.invoice, customer: "cus_other" },
    { ...f.invoice, subscription: "sub_other" },
    { ...f.invoice, livemode: true },
    { ...f.invoice, currency: "eur" },
    { ...f.invoice, automatic_tax: { enabled: true, status: "requires_location_inputs" } },
    { ...f.invoice, total: 3000 },
    { ...f.invoice, subtotal: 5000 },
    { ...f.invoice, tax: null },
    { ...f.invoice, amount_due: undefined },
    { ...f.invoice, lines: { ...f.invoice.lines, has_more: true } },
    { ...f.invoice, lines: { has_more: false, data: [line, line] } },
    ...[
      { ...line, subscription: "sub_other" },
      { ...line, proration: true },
      { ...line, price: { id: "price_other" } },
      { ...line, period: { ...line.period, start: line.period.start + 1 } },
    ].map((changed) => ({ ...f.invoice, lines: { has_more: false, data: [changed] } })),
  ]) {
    preview = raw;
    await expect(
      service.readOrganizationSubscriptionRenewalReview(f.input, session),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_REOBSERVE" });
  }
  expect(update).not.toHaveBeenCalled();
});
test("session loss and a pending command during provider IO discard the review", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, async () => {
      if (++checks === 2) throw new Error("session expired");
    }),
  ).rejects.toThrow("session expired");
  beforePreviewReturn = async () => {
    await repo.prepareCancellation({ ...f.input, idempotencyKey: randomUUID() }, "resume");
  };
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(update).not.toHaveBeenCalled();
});

test("an active uncancelled subscription or missing entitlement cannot receive a reversal review", async () => {
  const active = await seedCancellationTestAccount();
  const count = customerRead.mock.calls.length;
  await expect(
    service.readOrganizationSubscriptionRenewalReview(active.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(customerRead.mock.calls.length).toBe(count);
  const f = await fixture();
  await client
    .getPgliteClientForTests()
    .query("DELETE FROM organization_entitlements WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  await expect(
    service.readOrganizationSubscriptionRenewalReview(f.input, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(customerRead.mock.calls.length).toBe(count);
});

async function reviewedFixture() {
  const f = await fixture();
  const review = await service.readOrganizationSubscriptionRenewalReview(f.input, session);
  const confirm = {
    ...f.input,
    idempotencyKey: randomUUID(),
    expectedRenewalTermsDigest: review.termsDigest,
  };
  updateImpl = async () => {
    subscription = { ...f.scheduled, cancel_at_period_end: false, cancel_at: null };
    return subscription;
  };
  return { ...f, review, confirm };
}
test("reviewed confirmation persists terms, dispatches once and replays after the source revision changes", async () => {
  const f = await reviewedFixture();
  const result = await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
    f.confirm,
    session,
  );
  expect(result).toMatchObject({ status: "APPLIED", resultSubscriptionRevision: "3" });
  expect(update).toHaveBeenCalledTimes(1);
  expect(update.mock.calls[0]).toEqual([
    f.source.stripe_subscription_id,
    { cancel_at_period_end: false },
    { idempotencyKey: `organization-cancellation:${result.commandId}`, maxNetworkRetries: 0 },
  ]);
  const receipt = await repo.readCancellationRenewalReview(f.input, result.commandId);
  expect(receipt?.termsDigest).toBe(f.review.termsDigest);
  expect(receipt?.amountDueCents).toBe(2640);
  const reads = previewRead.mock.calls.length;
  expect(
    await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(f.confirm, session),
  ).toEqual(result);
  expect(previewRead.mock.calls.length).toBe(reads);
  expect(update).toHaveBeenCalledTimes(1);
  await expect(
    cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
      { ...f.confirm, expectedRenewalTermsDigest: "b".repeat(64) },
      session,
    ),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
});
test("terms changed before admission produce no new command or provider mutation", async () => {
  const f = await reviewedFixture();
  preview = { ...f.invoice, starting_balance: -500, amount_due: 2740 };
  await expect(
    cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(f.confirm, session),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_RENEWAL_TERMS_CHANGED" });
  expect(update).not.toHaveBeenCalled();
  const commands = await client
    .getPgliteClientForTests()
    .query("SELECT kind FROM billing_subscription_commands WHERE organization_id=$1", [
      f.input.organizationId,
    ]);
  expect(commands.rows).toEqual([{ kind: "cancel" }]);
});
test("pre-dispatch drift is durable FAILED and requires new terms and explicit new intent", async () => {
  const f = await reviewedFixture();
  let previews = 0;
  beforePreviewReturn = async () => {
    if (++previews === 2) preview = { ...f.invoice, starting_balance: -500, amount_due: 2740 };
  };
  const failed = await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
    f.confirm,
    session,
  );
  expect(failed.status).toBe("FAILED");
  expect(update).not.toHaveBeenCalled();
  expect(
    await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(f.confirm, session),
  ).toEqual(failed);
  const state = await client
    .getPgliteClientForTests()
    .query(
      "SELECT error_code,cancellation_dispatch_state FROM billing_subscription_commands WHERE id=$1",
      [failed.commandId],
    );
  expect(state.rows).toEqual([
    { error_code: "RENEWAL_REVIEW_REJECTED_BEFORE_DISPATCH", cancellation_dispatch_state: "ready" },
  ]);
  const fresh = await service.readOrganizationSubscriptionRenewalReview(f.input, session);
  expect(fresh.termsDigest).not.toBe(f.review.termsDigest);
  const retried = await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
    { ...f.confirm, idempotencyKey: randomUUID(), expectedRenewalTermsDigest: fresh.termsDigest },
    session,
  );
  expect(retried.status).toBe("APPLIED");
  expect(update).toHaveBeenCalledTimes(1);
});
test("lost provider response remains unknown and recovery observes without redispatch", async () => {
  const f = await reviewedFixture();
  updateImpl = async () => {
    subscription = { ...f.scheduled, cancel_at_period_end: false, cancel_at: null };
    throw new Error("controlled lost response after provider effect");
  };
  const uncertain = await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(
    f.confirm,
    session,
  );
  expect(uncertain.status).toBe("OUTCOME_UNKNOWN");
  expect(
    await cancellation.submitReviewedOrganizationSubscriptionCancellationUndo(f.confirm, session),
  ).toEqual(uncertain);
  expect(update).toHaveBeenCalledTimes(1);
  await cancellation.recoverOrganizationSubscriptionCancellations(100);
  expect(
    (
      await cancellation.readOrganizationSubscriptionCancellationUndo({
        ...f.input,
        commandId: uncertain.commandId,
      })
    ).status,
  ).toBe("APPLIED");
  expect(update).toHaveBeenCalledTimes(1);
});
test("fresh prepared review stays live; expired prepared review fails during read-only recovery", async () => {
  const f = await reviewedFixture();
  const fresh = await repo.prepareCancellation(
    { ...f.input, idempotencyKey: f.confirm.idempotencyKey, renewalReview: f.review },
    "resume",
  );
  await cancellation.recoverOrganizationSubscriptionCancellations(100);
  expect((await repo.readCancellation({ ...f.input, commandId: fresh.id }, "resume")).status).toBe(
    "PREPARED",
  );
  const older = await reviewedFixture();
  const command = await repo.prepareCancellation(
    { ...older.input, idempotencyKey: randomUUID() },
    "resume",
  );
  // A retained historical receipt whose deadline has passed; recovery must never reconstruct a dispatch.
  const expired = {
    ...older.review,
    observedAt: new Date(Date.now() - 120000).toISOString(),
    expiresAt: new Date(Date.now() - 60000).toISOString(),
  };
  await client
    .getPgliteClientForTests()
    .query(
      "INSERT INTO billing_subscription_renewal_reviews(command_id,organization_id,payload,expires_at) VALUES($1,$2,$3::jsonb,$4)",
      [command.id, older.input.organizationId, JSON.stringify(expired), expired.expiresAt],
    );
  await cancellation.recoverOrganizationSubscriptionCancellations(100);
  expect(
    (await repo.readCancellation({ ...older.input, commandId: command.id }, "resume")).status,
  ).toBe("FAILED");
  expect(update).not.toHaveBeenCalled();
});
test("a started or expired lease cannot be labelled a proven pre-dispatch failure", async () => {
  const f = await reviewedFixture();
  const command = await repo.prepareCancellation(
    { ...f.input, idempotencyKey: f.confirm.idempotencyKey, renewalReview: f.review },
    "resume",
  );
  const claim = await repo.claimCancellation({ ...f.input, commandId: command.id }, "resume");
  if (!claim) throw new Error("Missing review claim");
  await repo.assertCancellationClaimCurrent(f.input, claim, true);
  expect(await repo.failReviewedCancellationBeforeDispatch(f.input, claim)).toBe(false);
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [command.id],
    );
  expect(await repo.failReviewedCancellationBeforeDispatch(f.input, claim)).toBe(false);
  expect(
    (await repo.readCancellation({ ...f.input, commandId: command.id }, "resume")).status,
  ).toBe("OUTCOME_UNKNOWN");
});
test("review receipts cannot be rewritten, deleted, transplanted or attached to a cancellation", async () => {
  const f = await reviewedFixture();
  const command = await repo.prepareCancellation(
    { ...f.input, idempotencyKey: f.confirm.idempotencyKey, renewalReview: f.review },
    "resume",
  );
  const query = (sql: string, values: unknown[]) =>
    client.getPgliteClientForTests().query(sql, values);
  await expect(
    query(
      "UPDATE billing_subscription_renewal_reviews SET payload=jsonb_set(payload,'{amountDueCents}','1'::jsonb) WHERE command_id=$1",
      [command.id],
    ),
  ).rejects.toThrow();
  await expect(
    query("DELETE FROM billing_subscription_renewal_reviews WHERE command_id=$1", [command.id]),
  ).rejects.toThrow();
  const other = await seedCancellationTestAccount();
  const cancel = await repo.prepareCancellation(other.input);
  await expect(
    query(
      "INSERT INTO billing_subscription_renewal_reviews(command_id,organization_id,payload,expires_at) VALUES($1,$2,$3::jsonb,($3::jsonb->>'expiresAt')::timestamptz)",
      [cancel.id, other.input.organizationId, JSON.stringify(f.review)],
    ),
  ).rejects.toThrow();
  await expect(
    query(
      "INSERT INTO billing_subscription_renewal_reviews(command_id,organization_id,payload,expires_at) VALUES($1,$2,$3::jsonb,($3::jsonb->>'expiresAt')::timestamptz)",
      [cancel.id, f.input.organizationId, JSON.stringify(f.review)],
    ),
  ).rejects.toThrow();
});

/** A provider observation that only moves the subscription's lifecycle revision forward. */
async function advanceSubscription(organizationId: string, subscriptionId: string) {
  const { subscriptionAuthorityRepository } = await import(
    "../../db/repositories/subscription-authority"
  );
  const { subscriptionEntitlementsRepository } = await import(
    "../../db/repositories/subscription-entitlements"
  );
  const current = await subscriptionAuthorityRepository.findById(organizationId, subscriptionId);
  if (!current) throw new Error("Missing fixture subscription");
  const {
    id: _id,
    organization_id: _organization,
    lifecycle_revision: revision,
    created_at: _created,
    updated_at: _updated,
    ...values
  } = current;
  const advanced = await subscriptionAuthorityRepository.advance({
    organizationId,
    subscriptionId,
    expectedRevision: revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: { ...values, provider_object_digest: randomUUID().replaceAll("-", "").repeat(2) },
  });
  const projection = await client
    .getPgliteClientForTests()
    .query<{ projection_revision: number }>(
      "SELECT projection_revision FROM organization_entitlements WHERE organization_id=$1 AND billing_scope_id IS NULL",
      [organizationId],
    );
  await subscriptionEntitlementsRepository.rebuild({
    organizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: Number(projection.rows[0]?.projection_revision ?? 0),
  });
  return advanced.subscription.lifecycle_revision;
}

test("a cancellation prepared before the subscription moved on is superseded, not left blocking", async () => {
  update.mockClear();
  updateImpl = async () => {
    throw new Error("A stale prepared command must never dispatch");
  };
  const f = await seedCancellationTestAccount();
  const stale = await repo.prepareCancellation(f.input);
  const revision = await advanceSubscription(f.input.organizationId, f.input.subscriptionId);

  // Replaying the same intent settles it without a provider call.
  const replay = await cancellation.submitOrganizationSubscriptionCancellation(f.input, session);
  expect(replay).toMatchObject({ commandId: stale.id, status: "SUPERSEDED" });
  expect(update).not.toHaveBeenCalled();

  // A new intent against the current revision is admitted.
  const next = await repo.prepareCancellation({
    ...f.input,
    idempotencyKey: randomUUID(),
    expectedSubscriptionRevision: revision,
  });
  expect(next.status).toBe("PREPARED");
});

test("a new intent supersedes a stale prepared cancellation that was never replayed", async () => {
  update.mockClear();
  const f = await seedCancellationTestAccount();
  const stale = await repo.prepareCancellation(f.input);
  const revision = await advanceSubscription(f.input.organizationId, f.input.subscriptionId);

  const next = await repo.prepareCancellation({
    ...f.input,
    idempotencyKey: randomUUID(),
    expectedSubscriptionRevision: revision,
  });
  expect(next.status).toBe("PREPARED");
  const settled = await client
    .getPgliteClientForTests()
    .query(
      "SELECT status,error_code,provider_started_at FROM billing_subscription_commands WHERE id=$1",
      [stale.id],
    );
  expect(settled.rows).toEqual([
    {
      status: "SUPERSEDED",
      error_code: "SUBSCRIPTION_CHANGED_BEFORE_DISPATCH",
      provider_started_at: null,
    },
  ]);
  expect(update).not.toHaveBeenCalled();
});

test("recovery supersedes an expired reviewed undo whose subscription moved on", async () => {
  const f = await reviewedFixture();
  update.mockClear();
  const command = await repo.prepareCancellation(
    { ...f.input, idempotencyKey: randomUUID() },
    "resume",
  );
  const expired = {
    ...f.review,
    observedAt: new Date(Date.now() - 120000).toISOString(),
    expiresAt: new Date(Date.now() - 60000).toISOString(),
  };
  await client
    .getPgliteClientForTests()
    .query(
      "INSERT INTO billing_subscription_renewal_reviews(command_id,organization_id,payload,expires_at) VALUES($1,$2,$3::jsonb,$4)",
      [command.id, f.input.organizationId, JSON.stringify(expired), expired.expiresAt],
    );
  await advanceSubscription(f.input.organizationId, f.input.subscriptionId);

  await cancellation.recoverOrganizationSubscriptionCancellations(100);
  expect(
    (await repo.readCancellation({ ...f.input, commandId: command.id }, "resume")).status,
  ).toBe("SUPERSEDED");
  expect(update).not.toHaveBeenCalled();
});

test("a claimed cancellation with unknown outcome remains blocking after the source advances", async () => {
  update.mockClear();
  const f = await seedCancellationTestAccount();
  const command = await repo.prepareCancellation(f.input);
  const claim = await repo.claimCancellation({ ...f.input, commandId: command.id });
  if (!claim) throw new Error("Missing fixture claim");
  await repo.releaseCancellation(f.input, claim);
  const revision = await advanceSubscription(f.input.organizationId, f.input.subscriptionId);
  await expect(repo.claimCancellation({ ...f.input, commandId: command.id })).rejects.toMatchObject(
    {
      context: { reason: "source_changed_or_unsupported" },
    },
  );
  await expect(
    repo.prepareCancellation({
      ...f.input,
      idempotencyKey: randomUUID(),
      expectedSubscriptionRevision: revision,
    }),
  ).rejects.toMatchObject({ context: { reason: "contradictory_command_pending" } });
  expect((await repo.readCancellation({ ...f.input, commandId: command.id })).status).toBe(
    "OUTCOME_UNKNOWN",
  );
  expect(update).not.toHaveBeenCalled();
});
