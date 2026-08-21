/**
 * Exercises subscription operation repositories against real PGlite, including exact replay,
 * tenant isolation, lease takeover, provider ambiguity, receipt application, and fence CAS.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "51000000-0000-4000-8000-000000000001";
const ORG_B = "51000000-0000-4000-8000-000000000002";
const USER = "52000000-0000-4000-8000-000000000001";
const SUB_A = "53000000-0000-4000-8000-000000000001";
const SUB_B = "53000000-0000-4000-8000-000000000002";
const COMMAND = "54000000-0000-4000-8000-000000000001";
const RECEIPT = "55000000-0000-4000-8000-000000000001";
const INCIDENT = "56000000-0000-4000-8000-000000000001";
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const BASE = Date.parse("2026-08-20T12:00:00.000Z");

setDefaultTimeout(120_000);

let closeDatabaseConnectionsForTests:
  | typeof import("../client").closeDatabaseConnectionsForTests
  | undefined;
let getPgliteClientForTests: typeof import("../client").getPgliteClientForTests;
let repository: import("./subscription-billing-operations").SubscriptionBillingOperationsRepository;

function at(offset: number): Date {
  return new Date(BASE + offset);
}

async function applyMigration(name: string): Promise<void> {
  const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await getPgliteClientForTests().exec(statement);
  }
}

async function enqueue(
  overrides: Partial<
    import("./subscription-billing-operations").EnqueueSubscriptionCommandInput
  > = {},
) {
  return repository.enqueueCommand({
    id: COMMAND,
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    requestedByUserId: USER,
    kind: "upgrade",
    targetPlanKey: "pro_monthly",
    expectedSubscriptionRevision: 1,
    idempotencyKey: "command:exact-one",
    stripeIdempotencyKey: "stripe-command-exact-one",
    requestDigest: DIGEST_A,
    now: at(0),
    ...overrides,
  });
}

async function recordEvent(
  overrides: Partial<import("./subscription-billing-operations").RecordSubscriptionEventInput> = {},
) {
  return repository.recordEvent({
    id: RECEIPT,
    organizationId: ORG_A,
    subscriptionId: SUB_A,
    stripeEventId: "evt_exact1",
    eventType: "invoice.paid",
    stripeObjectType: "invoice",
    stripeObjectId: "in_exact1",
    livemode: false,
    eventCreatedAt: at(0),
    payloadDigest: DIGEST_A,
    now: at(1),
    ...overrides,
  });
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, getPgliteClientForTests } = await import("../client"));
  ({ subscriptionBillingOperationsRepository: repository } = await import(
    "./subscription-billing-operations"
  ));
  await getPgliteClientForTests().exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
  `);
  for (const migration of [
    "0275_subscription_lifecycle_authority.sql",
    "0283_billing_subscription_commands.sql",
    "0284_subscription_billing_fences.sql",
    "0285_billing_subscription_event_receipts.sql",
    "0286_billing_subscription_incidents.sql",
  ]) {
    await applyMigration(migration);
  }
});

beforeEach(async () => {
  await getPgliteClientForTests().exec(`
    TRUNCATE TABLE billing_subscriptions, users, organizations CASCADE;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO users (id) VALUES ('${USER}');
    INSERT INTO billing_subscriptions (
      id, organization_id, stripe_subscription_id, stripe_subscription_item_id,
      plan_key, catalog_version, status, current_period_start, current_period_end,
      lifecycle_revision, provider_object_version, provider_object_digest
    ) VALUES
      ('${SUB_A}', '${ORG_A}', 'sub_repoa', 'si_repoa', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 1, '${DIGEST_A}'),
      ('${SUB_B}', '${ORG_B}', 'sub_repob', 'si_repob', 'plus_monthly', 'v1', 'active',
       '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 1, 1, '${DIGEST_A}');
    INSERT INTO billing_subscription_revisions (
      organization_id, subscription_id, revision, source, stripe_subscription_id,
      stripe_subscription_item_id, plan_key, catalog_version, status,
      current_period_start, current_period_end, cancel_at_period_end,
      provider_object_version, provider_object_digest
    ) VALUES ('${ORG_A}', '${SUB_A}', 1, 'webhook', 'sub_repoa', 'si_repoa',
      'plus_monthly', 'v1', 'active', '2026-08-01T00:00:00Z',
      '2026-09-01T00:00:00Z', false, 1, '${DIGEST_A}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("SubscriptionBillingOperationsRepository", () => {
  test("accepts exact command replay and rejects digest or tenant divergence", async () => {
    expect((await enqueue()).replayed).toBe(false);
    expect((await enqueue()).replayed).toBe(true);
    await expect(enqueue({ requestDigest: DIGEST_B })).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    await expect(
      enqueue({
        id: randomUUID(),
        idempotencyKey: "command:other-one",
        stripeIdempotencyKey: "stripe-command-exact-one",
      }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
    expect(await repository.findCommand(ORG_B, COMMAND)).toBeUndefined();
  });

  test("claims and reclaims only pre-provider commands, then reconciles ambiguity", async () => {
    await enqueue();
    const firstToken = randomUUID();
    expect(
      await repository.claimCommand({
        organizationId: ORG_A,
        commandId: COMMAND,
        leaseToken: firstToken,
        now: at(10),
        leaseExpiresAt: at(100),
      }),
    ).toMatchObject({ attempt_count: 1 });
    expect(
      await repository.claimCommand({
        organizationId: ORG_A,
        commandId: COMMAND,
        leaseToken: randomUUID(),
        now: at(20),
        leaseExpiresAt: at(120),
      }),
    ).toBeNull();
    const takeoverToken = randomUUID();
    expect(
      await repository.claimCommand({
        organizationId: ORG_A,
        commandId: COMMAND,
        leaseToken: takeoverToken,
        now: at(101),
        leaseExpiresAt: at(200),
      }),
    ).toMatchObject({ attempt_count: 2, lease_token: takeoverToken });
    await repository.markCommandProviderStarted({
      organizationId: ORG_A,
      commandId: COMMAND,
      leaseToken: takeoverToken,
      now: at(110),
    });
    expect(
      await repository.claimCommand({
        organizationId: ORG_A,
        commandId: COMMAND,
        leaseToken: randomUUID(),
        now: at(201),
        leaseExpiresAt: at(300),
      }),
    ).toBeNull();
    expect(await repository.listStuckCommands(at(201), 10)).toHaveLength(1);
    await repository.markCommandAmbiguous({
      organizationId: ORG_A,
      commandId: COMMAND,
      leaseToken: takeoverToken,
      errorCode: "STRIPE_TIMEOUT",
      now: at(202),
    });
    const reconciliation = {
      organizationId: ORG_A,
      commandId: COMMAND,
      outcome: "succeeded" as const,
      providerResponseDigest: DIGEST_B,
      errorCode: null,
      now: at(300),
    };
    expect(await repository.reconcileAmbiguousCommand(reconciliation)).toMatchObject({
      status: "succeeded",
      provider_response_digest: DIGEST_B,
    });
    expect(await repository.reconcileAmbiguousCommand(reconciliation)).toMatchObject({
      status: "succeeded",
    });
  });

  test("deduplicates exact provider events and lease-CAS applies one revision", async () => {
    expect((await recordEvent()).replayed).toBe(false);
    expect((await recordEvent()).replayed).toBe(true);
    await expect(recordEvent({ payloadDigest: DIGEST_B })).rejects.toMatchObject({
      code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT",
    });
    expect(await repository.findEventReceipt(ORG_B, RECEIPT)).toBeUndefined();
    const token = randomUUID();
    await repository.claimEvent({
      organizationId: ORG_A,
      receiptId: RECEIPT,
      leaseToken: token,
      now: at(10),
      leaseExpiresAt: at(15),
    });
    expect(await repository.listStuckEvents(at(16), 10)).toHaveLength(1);
    const takeoverToken = randomUUID();
    expect(
      await repository.claimEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        now: at(16),
        leaseExpiresAt: at(100),
      }),
    ).toMatchObject({ attempt_count: 2, lease_token: takeoverToken });
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: randomUUID(),
        subscriptionRevision: 1,
        disposition: "allowance_granted",
        now: at(20),
      }),
    ).toBeNull();
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        subscriptionRevision: 1,
        disposition: "allowance_granted",
        now: at(20),
      }),
    ).toMatchObject({ status: "applied", applied_subscription_revision: 1 });
    expect(
      await repository.applyEvent({
        organizationId: ORG_A,
        receiptId: RECEIPT,
        leaseToken: takeoverToken,
        subscriptionRevision: 1,
        disposition: "allowance_granted",
        now: at(20),
      }),
    ).toMatchObject({ status: "applied" });
    const failedReceipt = await recordEvent({
      id: randomUUID(),
      stripeEventId: "evt_failed2",
      stripeObjectId: "in_failed2",
    });
    const failedToken = randomUUID();
    await repository.claimEvent({
      organizationId: ORG_A,
      receiptId: failedReceipt.value.id,
      leaseToken: failedToken,
      now: at(30),
      leaseExpiresAt: at(100),
    });
    await repository.failEvent({
      organizationId: ORG_A,
      receiptId: failedReceipt.value.id,
      leaseToken: failedToken,
      status: "failed",
      errorCode: "TRANSIENT_DB_ERROR",
      now: at(40),
    });
    expect(await repository.listStuckEvents(at(40), 10)).toHaveLength(1);
    expect(
      await repository.reconcileEvent({
        organizationId: ORG_A,
        receiptId: failedReceipt.value.id,
        outcome: "ignored",
        subscriptionRevision: null,
        disposition: "superseded_event",
        now: at(50),
      }),
    ).toMatchObject({ status: "ignored", error_code: null });
  });

  test("records exact incidents, scans due work, and resolves tenant-scoped evidence", async () => {
    await enqueue();
    await recordEvent();
    const input = {
      id: INCIDENT,
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      commandId: COMMAND,
      eventReceiptId: RECEIPT,
      kind: "provider_timeout" as const,
      severity: "error" as const,
      fingerprint: DIGEST_A,
      context: { provider: "stripe", timeout_ms: 10_000 },
      nextRetryAt: at(100),
      now: at(0),
    };
    expect((await repository.openIncident(input)).replayed).toBe(false);
    expect(await repository.openIncident(input)).toMatchObject({
      replayed: true,
      value: { occurrence_count: 2 },
    });
    expect(
      await repository.openIncident({
        ...input,
        context: { timeout_ms: 10_000, provider: "stripe" },
      }),
    ).toMatchObject({ replayed: true, value: { occurrence_count: 3 } });
    await expect(
      repository.openIncident({ ...input, context: { provider: "stripe", timeout_ms: 1 } }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_BILLING_OPERATIONS_CONFLICT" });
    expect(await repository.listDueIncidents(at(99), 10)).toHaveLength(0);
    expect(await repository.listDueIncidents(at(100), 10)).toHaveLength(1);
    expect(
      await repository.resolveIncident({
        organizationId: ORG_B,
        incidentId: INCIDENT,
        resolvedByUserId: null,
        resolution: "reconciled",
        now: at(200),
      }),
    ).toBeNull();
    expect(
      await repository.resolveIncident({
        organizationId: ORG_A,
        incidentId: INCIDENT,
        resolvedByUserId: null,
        resolution: "reconciled",
        now: at(200),
      }),
    ).toMatchObject({ status: "resolved" });
  });

  test("advances deletion fences monotonically and replays the exact reconciled state", async () => {
    const created = await repository.createFence({
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      providerObjectVersion: 1,
      providerEventId: null,
      providerEventCreatedAt: null,
      providerObjectDigest: DIGEST_A,
      nextReconcileAt: at(100),
      now: at(0),
    });
    expect(created.replayed).toBe(false);
    expect(await repository.findFence(ORG_B, SUB_A)).toBeUndefined();
    expect(await repository.listDueFences(at(99), 10)).toHaveLength(0);
    expect(await repository.listDueFences(at(100), 10)).toHaveLength(1);
    const advance = {
      organizationId: ORG_A,
      subscriptionId: SUB_A,
      expectedFenceRevision: 1,
      state: "deletion_requested" as const,
      providerObjectVersion: 2,
      providerEventId: "evt_delete1",
      providerEventCreatedAt: at(10),
      providerObjectDigest: DIGEST_B,
      deletionRequestedAt: at(20),
      providerDeletedAt: null,
      releasedAt: null,
      lastReconciledAt: at(20),
      nextReconcileAt: at(200),
      now: at(20),
    };
    expect(await repository.advanceFence(advance)).toMatchObject({
      replayed: false,
      value: { fence_revision: 2, state: "deletion_requested" },
    });
    expect(await repository.advanceFence(advance)).toMatchObject({ replayed: true });
    expect(
      await repository.advanceFence({
        ...advance,
        expectedFenceRevision: 2,
        providerObjectVersion: 1,
      }),
    ).toBeNull();
  });
});
