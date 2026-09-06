/** Exercises the actual cancellation command service, migrated primary transaction and controlled Stripe transport, including unknown outcomes and rollback. */
import { afterAll, beforeAll, beforeEach, expect, mock, setDefaultTimeout, test } from "bun:test";
import {
  installCancellationTestSchema,
  seedCancellationTestAccount,
} from "./subscription-cancellation-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.STRIPE_SECRET_KEY = "sk_test_cancellationfixture";
process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = "price_plus";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_plus";
process.env.STRIPE_PRO_MONTHLY_PRICE_ID = "price_pro";
process.env.STRIPE_PRO_PRODUCT_ID = "prod_pro";
setDefaultTimeout(120_000);
let customerRetrieve: (id: string) => Promise<unknown>;
let retrieve: (id: string) => Promise<unknown>;
let update: (id: string, params: unknown, options: unknown) => Promise<unknown>;
mock.module("../../lib/stripe", () => ({
  requireStripe: () => ({
    customers: { retrieve: (id: string) => customerRetrieve(id) },
    subscriptions: {
      retrieve: (id: string) => retrieve(id),
      update: (id: string, params: unknown, options: unknown) => update(id, params, options),
    },
  }),
}));
let client: typeof import("../client");
let service: typeof import("../../lib/services/subscription-cancellation");
let repository: typeof import("./subscription-cancellation");
beforeAll(async () => {
  client = await import("../client");
  await installCancellationTestSchema((query) => client.getPgliteClientForTests().exec(query));
  service = await import("../../lib/services/subscription-cancellation");
  repository = await import("./subscription-cancellation");
});
beforeEach(async () => {
  await client.getPgliteClientForTests().exec("DELETE FROM billing_subscription_commands;");
});
afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
});
async function fixture() {
  const f = await seedCancellationTestAccount();
  customerRetrieve = async (id) => ({ id, object: "customer", livemode: false });
  const effects: { id: string; params: unknown; options: unknown }[] = [];
  retrieve = async (id) => {
    expect(id).toBe(f.source.stripe_subscription_id);
    return structuredClone(f.provider);
  };
  update = async (id, params, options) => {
    effects.push({ id, params, options });
    f.provider.cancel_at_period_end = true;
    f.provider.cancel_at = f.provider.current_period_end;
    f.provider.canceled_at = Math.floor(Date.now() / 1000);
    return structuredClone(f.provider);
  };
  return { ...f, effects };
}
async function readback(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await client.getPgliteClientForTests().query(
      `SELECT s.lifecycle_revision,s.cancel_at_period_end,s.status,s.ended_at,
    e.source_subscription_revision,e.projection_revision,a.policy_generation,
    (SELECT count(*)::int FROM organization_policy_audit WHERE organization_id=s.organization_id) audit_count,
    (SELECT count(*)::int FROM billing_subscription_revisions WHERE subscription_id=s.id) revision_count
    FROM billing_subscriptions s JOIN organization_entitlements e ON e.organization_id=s.organization_id
    JOIN organization_subscription_authorities a ON a.organization_id=s.organization_id WHERE s.id=$1`,
      [f.input.subscriptionId],
    )
  ).rows;
}
test("manager request publishes scheduled cancellation atomically and exact replay has no extra provider effect or generation", async () => {
  const f = await fixture();
  let checks = 0;
  const before = await readback(f);
  const result = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {
    checks++;
  });
  expect(result.status).toBe("APPLIED");
  expect(result.resultSubscriptionRevision).toBe("2");
  expect(f.effects).toHaveLength(1);
  expect(f.effects[0]!.params).toEqual({ cancel_at_period_end: true });
  const command = await repository.readCancellation({ ...f.input, commandId: result.commandId });
  expect(f.effects[0]!.options).toEqual({ idempotencyKey: command.provider_idempotency_key });
  expect(checks).toBe(4);
  const after = await readback(f);
  expect(after).not.toEqual(before);
  expect(after[0]).toMatchObject({
    cancel_at_period_end: true,
    status: "active",
    ended_at: null,
    source_subscription_revision: 2,
    revision_count: 2,
  });
  expect(await service.submitOrganizationSubscriptionCancellation(f.input, async () => {})).toEqual(
    result,
  );
  expect(await readback(f)).toEqual(after);
  expect(f.effects).toHaveLength(1);
});
test("response loss retains unknown and recovery retrieves actual outcome without a second update", async () => {
  const f = await fixture();
  const effect = update;
  update = async (...args) => {
    await effect(...args);
    throw new Error("lost external response");
  };
  const pending = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(pending.status).toBe("OUTCOME_UNKNOWN");
  expect((await readback(f))[0]).toMatchObject({
    lifecycle_revision: 1,
    cancel_at_period_end: false,
  });
  const recovery = await service.recoverOrganizationSubscriptionCancellations(20);
  expect(recovery.applied).toBe(1);
  expect(f.effects).toHaveLength(1);
  expect(
    (
      await service.readOrganizationSubscriptionCancellation({
        ...f.input,
        commandId: pending.commandId,
      })
    ).status,
  ).toBe("APPLIED");
});
test("lost pre-dispatch attempt never grants unattended recovery mutation", async () => {
  const f = await fixture();
  const command = await repository.prepareCancellation(f.input);
  const claim = await repository.claimCancellation({ ...f.input, commandId: command.id });
  expect(claim).not.toBeNull();
  await repository.releaseCancellation(f.input, claim!);
  const recovery = await service.recoverOrganizationSubscriptionCancellations(20);
  expect(recovery.pending).toBeGreaterThan(0);
  expect(f.effects).toHaveLength(0);
  expect((await repository.readCancellation({ ...f.input, commandId: command.id })).status).toBe(
    "OUTCOME_UNKNOWN",
  );
});
test("foreign tenant and revoked manager cannot submit or inspect another tenant command", async () => {
  const f = await fixture();
  const other = await seedCancellationTestAccount();
  const command = await repository.prepareCancellation(f.input);
  await expect(
    service.readOrganizationSubscriptionCancellation({ ...other.input, commandId: command.id }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_NOT_FOUND" });
  await client
    .getPgliteClientForTests()
    .query("UPDATE users SET role='member' WHERE id=$1", [f.input.actorId]);
  await expect(
    service.submitOrganizationSubscriptionCancellation(f.input, async () => {}),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_FORBIDDEN" });
  expect(f.effects).toHaveLength(0);
});
test("expired lease between retrieval and dispatch blocks provider mutation", async () => {
  const f = await fixture();
  const observed = retrieve;
  retrieve = async (id) => {
    const value = await observed(id);
    await client
      .getPgliteClientForTests()
      .query(
        "UPDATE billing_subscription_commands SET lease_expires_at=now()-interval '1 second' WHERE organization_id=$1 AND status='OUTCOME_UNKNOWN'",
        [f.input.organizationId],
      );
    return value;
  };
  const result = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(result.status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(0);
  expect((await readback(f))[0]).toMatchObject({
    lifecycle_revision: 1,
    cancel_at_period_end: false,
  });
});
test("provider period drift after accepted mutation cannot publish mismatched source", async () => {
  const f = await fixture();
  const effect = update;
  update = async (...args) => {
    await effect(...args);
    f.provider.current_period_end += 86400;
    return structuredClone(f.provider);
  };
  const before = await readback(f);
  const result = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(result.status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(1);
  expect(await readback(f)).toEqual(before);
});
test("command-result failure rolls back source, journal, projection, generation and audit together", async () => {
  const f = await fixture();
  const before = await readback(f);
  await client
    .getPgliteClientForTests()
    .exec(`CREATE FUNCTION reject_cancel_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='APPLIED' THEN RAISE EXCEPTION 'result unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_cancel_result BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION reject_cancel_result();`);
  const pending = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(pending.status).toBe("OUTCOME_UNKNOWN");
  expect(await readback(f)).toEqual(before);
  await client
    .getPgliteClientForTests()
    .exec(
      "DROP TRIGGER reject_cancel_result ON billing_subscription_commands; DROP FUNCTION reject_cancel_result();",
    );
  await service.recoverOrganizationSubscriptionCancellations(20);
  expect(
    (
      await service.readOrganizationSubscriptionCancellation({
        ...f.input,
        commandId: pending.commandId,
      })
    ).status,
  ).toBe("APPLIED");
  expect(f.effects).toHaveLength(1);
});
test("different keys cannot create contradictory live intents and same key cannot change its digest", async () => {
  const f = await fixture();
  await repository.prepareCancellation(f.input);
  await expect(
    repository.prepareCancellation({ ...f.input, idempotencyKey: "other" }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  await expect(
    repository.prepareCancellation({ ...f.input, expectedSubscriptionRevision: 2 }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_CANCELLATION_CONFLICT" });
  expect(f.effects).toHaveLength(0);
});

test("a second simultaneous request cannot own the first provider lease", async () => {
  const f = await fixture();
  let reached!: () => void, unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const original = retrieve;
  let calls = 0;
  retrieve = async (id) => {
    calls++;
    if (calls === 1) {
      reached();
      await release;
    }
    return original(id);
  };
  const first = service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  await started;
  const second = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(second.status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(0);
  unblock();
  expect((await first).status).toBe("APPLIED");
  expect(f.effects).toHaveLength(1);
});
test("session revocation before dispatch remains an authorization failure and has zero provider mutations", async () => {
  const f = await fixture();
  let checks = 0;
  const { ForbiddenError } = await import("../../lib/api/cloud-worker-errors");
  await expect(
    service.submitOrganizationSubscriptionCancellation(f.input, async () => {
      if (++checks === 3) throw ForbiddenError("Session authority changed");
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.effects).toHaveLength(0);
  expect((await readback(f))[0]).toMatchObject({
    lifecycle_revision: 1,
    cancel_at_period_end: false,
  });
});
for (const mismatch of [
  "customer",
  "price",
  "environment",
  "schedule",
  "item",
  "ended",
  "pending",
] as const) {
  test(`unsupported provider ${mismatch} stays unknown without mutation or local publication`, async () => {
    const f = await fixture();
    const raw: Record<string, unknown> = structuredClone(f.provider);
    if (mismatch === "customer") raw.customer = "cus_foreign";
    if (mismatch === "price") {
      const copy = structuredClone(f.provider);
      copy.items.data[0]!.price.id = "price_other";
      raw.items = copy.items;
    }
    if (mismatch === "environment") raw.livemode = true;
    if (mismatch === "schedule") raw.schedule = "sub_sched_other";
    if (mismatch === "item") {
      const copy = structuredClone(f.provider);
      copy.items.data.push(copy.items.data[0]!);
      raw.items = copy.items;
    }
    if (mismatch === "ended") raw.ended_at = Math.floor(Date.now() / 1000);
    if (mismatch === "pending")
      raw.pending_update = { expires_at: Math.floor(Date.now() / 1000) + 600 };
    retrieve = async () => raw;
    const before = await readback(f);
    expect(
      (await service.submitOrganizationSubscriptionCancellation(f.input, async () => {})).status,
    ).toBe("OUTCOME_UNKNOWN");
    expect(f.effects).toHaveLength(0);
    expect(await readback(f)).toEqual(before);
  });
}
test("generic upgrade writer cannot pass a pending cancellation and leave contradictory durable work", async () => {
  const f = await fixture();
  await repository.prepareCancellation(f.input);
  const { subscriptionBillingOperationsRepository: operations } = await import(
    "./subscription-billing-operations"
  );
  await expect(
    operations.enqueueCommand({
      organizationId: f.input.organizationId,
      subscriptionId: f.input.subscriptionId,
      requestedByUserId: f.input.actorId,
      kind: "upgrade",
      targetPlanKey: "pro_monthly",
      expectedSubscriptionRevision: 1,
      idempotencyKey: "upgrade-after-cancel",
      providerIdempotencyKey: `upgrade:${f.input.organizationId}`,
      requestDigest: "b".repeat(64),
      now: new Date(),
    }),
  ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
  expect(
    (
      await client
        .getPgliteClientForTests()
        .query("SELECT kind FROM billing_subscription_commands WHERE organization_id=$1", [
          f.input.organizationId,
        ])
    ).rows,
  ).toEqual([{ kind: "cancel" }]);
});
test("recovery rotates an unauthorized oldest command and reaches a later confirmed provider outcome", async () => {
  const blocked = await fixture();
  const bad = await repository.prepareCancellation(blocked.input);
  const oldClaim = await repository.claimCancellation({ ...blocked.input, commandId: bad.id });
  await repository.releaseCancellation(blocked.input, oldClaim!);
  await client
    .getPgliteClientForTests()
    .query("UPDATE users SET role='member' WHERE id=$1", [blocked.input.actorId]);
  const f = await fixture();
  const good = await repository.prepareCancellation(f.input);
  const claim = await repository.claimCancellation({ ...f.input, commandId: good.id });
  await repository.releaseCancellation(f.input, claim!);
  f.provider.cancel_at_period_end = true;
  f.provider.cancel_at = f.provider.current_period_end;
  f.provider.canceled_at = Math.floor(Date.now() / 1000);
  const first = await service.recoverOrganizationSubscriptionCancellations(1);
  expect(first.unavailable).toBe(1);
  const second = await service.recoverOrganizationSubscriptionCancellations(1);
  expect(second.applied).toBe(1);
  expect(f.effects).toHaveLength(0);
});

test("scheduled cancellation keeps paid policy while rejecting cached pre-command generation", async () => {
  const f = await fixture();
  const { readOrganizationQuotaPolicy } = await import(
    "../../lib/services/organization-quota-policy"
  );
  const { withOrganizationPolicyAdmission } = await import(
    "../../lib/services/organization-policy-admission"
  );
  const before = await readOrganizationQuotaPolicy(f.input.organizationId);
  const result = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(result.status).toBe("APPLIED");
  const after = await readOrganizationQuotaPolicy(f.input.organizationId);
  expect(after.tier).toEqual(before.tier);
  expect(after.limits).toEqual(before.limits);
  expect(after.authority.generation).not.toBe(before.authority.generation);
  await expect(
    withOrganizationPolicyAdmission(
      f.input.organizationId,
      before.authority,
      async () => "dispatched",
    ),
  ).rejects.toMatchObject({ code: "ORGANIZATION_POLICY_STALE" });
  expect(
    await withOrganizationPolicyAdmission(
      f.input.organizationId,
      after.authority,
      async (policy) => policy.tier,
    ),
  ).toEqual(after.tier);
});

test("initial retrieval failure permits fresh authenticated same-key ready retry exactly once", async () => {
  const f = await fixture();
  const original = retrieve;
  retrieve = async () => {
    throw new Error("temporary retrieval failure");
  };
  const first = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(first.status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(0);
  expect(
    (await repository.readCancellation({ ...f.input, commandId: first.commandId }))
      .cancellation_dispatch_state,
  ).toBe("ready");
  retrieve = original;
  const second = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(second.status).toBe("APPLIED");
  expect(second.commandId).toBe(first.commandId);
  expect(f.effects).toHaveLength(1);
});
test("crash after durable dispatch start never permits blind same-key resend", async () => {
  const f = await fixture();
  const command = await repository.prepareCancellation(f.input);
  const claim = await repository.claimCancellation({ ...f.input, commandId: command.id });
  await repository.assertCancellationClaimCurrent(f.input, claim!, true);
  await repository.releaseCancellation(f.input, claim!);
  expect(
    (await service.submitOrganizationSubscriptionCancellation(f.input, async () => {})).status,
  ).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(0);
  await expect(
    client
      .getPgliteClientForTests()
      .query(
        "UPDATE billing_subscription_commands SET cancellation_dispatch_state='ready' WHERE id=$1",
        [command.id],
      ),
  ).rejects.toThrow();
});
for (const invalid of ["deleted", "identity", "environment"] as const) {
  test(`canonical Customer ${invalid} prevents any cancellation effect`, async () => {
    const f = await fixture();
    customerRetrieve = async (id) =>
      invalid === "deleted"
        ? { id, object: "customer", deleted: true }
        : {
            id: invalid === "identity" ? "cus_wrong" : id,
            object: "customer",
            livemode: invalid === "environment",
          };
    const before = await readback(f);
    expect(
      (await service.submitOrganizationSubscriptionCancellation(f.input, async () => {})).status,
    ).toBe("OUTCOME_UNKNOWN");
    expect(f.effects).toHaveLength(0);
    expect(await readback(f)).toEqual(before);
  });
}
test("Customer deleted after provider effect prevents local publication", async () => {
  const f = await fixture();
  const effect = update;
  update = async (...args) => {
    const result = await effect(...args);
    customerRetrieve = async (id) => ({ id, object: "customer", deleted: true });
    return result;
  };
  const before = await readback(f);
  expect(
    (await service.submitOrganizationSubscriptionCancellation(f.input, async () => {})).status,
  ).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(1);
  expect(await readback(f)).toEqual(before);
});

test("credential revoked during final Customer preflight blocks mutation", async () => {
  const f = await fixture();
  let customerReads = 0,
    revoked = false;
  customerRetrieve = async (id) => {
    if (++customerReads === 2) revoked = true;
    return { id, object: "customer", livemode: false };
  };
  const { ForbiddenError } = await import("../../lib/api/cloud-worker-errors");
  await expect(
    service.submitOrganizationSubscriptionCancellation(f.input, async () => {
      if (revoked) throw ForbiddenError("Revoked");
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(f.effects).toHaveLength(0);
});

test("provider request outliving its lease cannot publish or trigger a second mutation", async () => {
  const f = await fixture();
  let reached!: () => void, unblock!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const effect = update;
  update = async (...args) => {
    reached();
    await release;
    return effect(...args);
  };
  const first = service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  await started;
  await client
    .getPgliteClientForTests()
    .query(
      "UPDATE billing_subscription_commands SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1",
      [f.input.organizationId],
    );
  const retry = await service.submitOrganizationSubscriptionCancellation(f.input, async () => {});
  expect(retry.status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(0);
  unblock();
  expect((await first).status).toBe("OUTCOME_UNKNOWN");
  expect(f.effects).toHaveLength(1);
  expect((await readback(f))[0]).toMatchObject({ lifecycle_revision: 1 });
  expect((await service.recoverOrganizationSubscriptionCancellations(5)).applied).toBe(1);
  expect(f.effects).toHaveLength(1);
});
