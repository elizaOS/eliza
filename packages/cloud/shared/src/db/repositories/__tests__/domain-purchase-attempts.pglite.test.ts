/**
 * Proves the domain-purchase authority against a real PGlite database.
 *
 * The harness runs the append-only migration, exercises concurrent claims and
 * lease recovery, and verifies tenant, amount, request, charge, and refund
 * bindings at the database boundary rather than mocking repository results.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

const ORG_A = "10000000-0000-4000-8000-000000000001";
const ORG_B = "10000000-0000-4000-8000-000000000002";
const APP_A = "20000000-0000-4000-8000-000000000001";
const APP_B = "20000000-0000-4000-8000-000000000002";
const DIGEST = "a".repeat(64);

let dbWrite: typeof import("../../client").dbWrite;
let closeDb: typeof import("../../client").closeDatabaseConnectionsForTests;
let repository: typeof import("../domain-purchase-attempts").domainPurchaseAttemptsRepository;

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ domainPurchaseAttemptsRepository: repository } = await import("../domain-purchase-attempts"));

  const pglite = client.getPgliteClientForTests();
  if (!pglite) throw new Error("PGlite test client was not initialized");
  await pglite.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE apps (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id)
    );
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      amount numeric(12,6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}',
      stripe_payment_intent_id text UNIQUE,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE managed_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id),
      domain text NOT NULL
    );
    CREATE TABLE domain_purchase_idempotency (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      app_id uuid NOT NULL REFERENCES apps(id),
      domain text NOT NULL,
      status text NOT NULL DEFAULT 'processing',
      charge_id uuid,
      charge jsonb,
      cloudflare_registration_id text,
      managed_domain_id uuid,
      response_body jsonb,
      error_code text,
      expires_at timestamp NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    );
    INSERT INTO organizations(id) VALUES ('${ORG_A}'), ('${ORG_B}');
    INSERT INTO apps(id, organization_id) VALUES
      ('${APP_A}', '${ORG_A}'), ('${APP_B}', '${ORG_B}');
  `);
  const migration = await Bun.file(
    new URL("../../migrations/0260_domain_purchase_authority.sql", import.meta.url),
  ).text();
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
});

afterAll(async () => {
  await closeDb();
});

beforeEach(async () => {
  await dbWrite.execute(sql`DELETE FROM domain_purchase_idempotency`);
  await dbWrite.execute(sql`DELETE FROM managed_domains`);
  await dbWrite.execute(sql`DELETE FROM credit_transactions`);
});

function createInput() {
  return {
    key: `domain-buy:${ORG_A}:example.com`,
    organizationId: ORG_A,
    appId: APP_A,
    domain: "example.com",
    requestDigest: DIGEST,
    registrationYears: 1,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

const QUOTE = {
  totalUsdCents: 1499,
  wholesaleUsdCents: 1099,
  marginUsdCents: 400,
  registrationWholesaleUsdCents: 1099,
  renewalWholesaleUsdCents: 1099,
  renewalUsdCents: 1499,
  years: 1,
  currency: "USD" as const,
};

async function quoteAttempt() {
  const input = createInput();
  await repository.createOrRead(input);
  return repository.storeQuote({
    key: input.key,
    organizationId: ORG_A,
    requestDigest: DIGEST,
    quote: QUOTE,
    expiresAt: input.expiresAt,
  });
}

async function insertCharge(input?: {
  organizationId?: string;
  amount?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  stripePaymentIntentId?: string | null;
}) {
  const rows = await dbWrite.execute(sql`
    INSERT INTO credit_transactions (
      organization_id, amount, type, metadata, stripe_payment_intent_id
    ) VALUES (
      ${input?.organizationId ?? ORG_A},
      ${input?.amount ?? "-14.99"}::numeric,
      ${input?.type ?? "debit"},
      ${JSON.stringify(
        input?.metadata ?? {
          type: "domain_purchase",
          domain: "example.com",
          domainPurchaseKey: `domain-buy:${ORG_A}:example.com`,
        },
      )}::jsonb,
      ${
        input && "stripePaymentIntentId" in input
          ? input.stripePaymentIntentId
          : `domain-purchase:${ORG_A}:example.com`
      }
    ) RETURNING id
  `);
  return String((rows.rows[0] as { id: string }).id);
}

async function insertRefund(input?: {
  amount?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  stripePaymentIntentId?: string | null;
}) {
  const rows = await dbWrite.execute(sql`
    INSERT INTO credit_transactions (
      organization_id, amount, type, metadata, stripe_payment_intent_id
    ) VALUES (
      ${ORG_A}, ${input?.amount ?? "14.99"}::numeric,
      ${input?.type ?? "refund"},
      ${JSON.stringify(
        input?.metadata ?? {
          type: "domain_purchase_refund",
          domain: "example.com",
          domainPurchaseKey: `domain-buy:${ORG_A}:example.com`,
        },
      )}::jsonb,
      ${
        input && "stripePaymentIntentId" in input
          ? input.stripePaymentIntentId
          : `domain-purchase-refund:${ORG_A}:example.com`
      }
    ) RETURNING id
  `);
  return String((rows.rows[0] as { id: string }).id);
}

async function expectDbCause(promise: Promise<unknown>, fragment: string): Promise<void> {
  try {
    await promise;
    throw new Error("expected database operation to fail");
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : error;
    expect(String(cause)).toContain(fragment);
  }
}

describe("domain purchase durable authority", () => {
  test("deletes an expired legacy claim only when no unrefunded debit exists", async () => {
    const input = createInput();
    await dbWrite.execute(sql`
      INSERT INTO domain_purchase_idempotency (
        key, organization_id, app_id, domain, status, expires_at
      ) VALUES (
        ${input.key}, ${ORG_A}, ${APP_A}, ${input.domain}, 'processing',
        now() - interval '1 second'
      )
    `);
    expect(
      await repository.deleteExpiredLegacyUncharged({
        key: input.key,
        organizationId: ORG_A,
        now: new Date(),
      }),
    ).toBe(true);
    expect(await repository.read(input.key)).toBeNull();
  });

  test("preserves an expired legacy claim whose old worker may have debited", async () => {
    const input = createInput();
    await dbWrite.execute(sql`
      INSERT INTO domain_purchase_idempotency (
        key, organization_id, app_id, domain, status, expires_at
      ) VALUES (
        ${input.key}, ${ORG_A}, ${APP_A}, ${input.domain}, 'processing',
        now() - interval '1 second'
      )
    `);
    await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata
      ) VALUES (
        ${ORG_A}, -14.99, 'debit',
        ${JSON.stringify({
          type: "domain_purchase",
          domain: "example.com",
          appId: APP_A,
        })}::jsonb
      )
    `);
    expect(
      await repository.deleteExpiredLegacyUncharged({
        key: input.key,
        organizationId: ORG_A,
        now: new Date(),
      }),
    ).toBe(false);
    expect((await repository.read(input.key))?.request_digest).toBeNull();
  });

  test("single-flights concurrent creation and rejects a different app tenant", async () => {
    const results = await Promise.all([
      repository.createOrRead(createInput()),
      repository.createOrRead(createInput()),
      repository.createOrRead(createInput()),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.attempt.id)).size).toBe(1);

    await expectDbCause(
      repository.createOrRead({
        ...createInput(),
        key: `domain-buy:${ORG_A}:other.com`,
        appId: APP_B,
        domain: "other.com",
      }),
      "app tenant binding mismatch",
    );
  });

  test("pins the registration term at creation and rejects missing or mutated terms", async () => {
    const created = await repository.createOrRead({
      ...createInput(),
      registrationYears: 2,
    });
    expect(created.attempt.registration_years).toBe(2);

    await expectDbCause(
      dbWrite.execute(sql`
        UPDATE domain_purchase_idempotency
        SET registration_years = 1
        WHERE key = ${createInput().key}
      `),
      "immutable binding changed",
    );

    await dbWrite.execute(sql`DELETE FROM domain_purchase_idempotency`);
    await expectDbCause(
      dbWrite.execute(sql`
        INSERT INTO domain_purchase_idempotency (
          key, organization_id, app_id, domain, status, request_digest,
          registration_years, expires_at
        ) VALUES (
          ${createInput().key}, ${ORG_A}, ${APP_A}, ${createInput().domain},
          'processing', ${DIGEST}, NULL, now() + interval '1 minute'
        )
      `),
      "registration_years_check",
    );

    await repository.createOrRead({
      ...createInput(),
      registrationYears: 2,
    });
    await expectDbCause(
      repository.storeQuote({
        key: createInput().key,
        organizationId: ORG_A,
        requestDigest: DIGEST,
        quote: QUOTE,
        expiresAt: createInput().expiresAt,
      }),
      "quote term binding mismatch",
    );
  });

  test("pins one quote and lets exactly one caller claim registrar start", async () => {
    await quoteAttempt();
    await expect(
      repository.storeQuote({
        ...createInput(),
        quote: { ...QUOTE, totalUsdCents: 1500 },
      }),
    ).rejects.toThrow("transition lost its row");

    const chargeId = await insertCharge();
    await repository.attachCharge({
      key: createInput().key,
      organizationId: ORG_A,
      requestDigest: DIGEST,
      chargeId,
    });
    const claims = await Promise.all([
      repository.claimRegistrarStart({
        key: createInput().key,
        organizationId: ORG_A,
        leaseToken: "30000000-0000-4000-8000-000000000001",
        claimedUntil: new Date(Date.now() + 60_000),
      }),
      repository.claimRegistrarStart({
        key: createInput().key,
        organizationId: ORG_A,
        leaseToken: "30000000-0000-4000-8000-000000000002",
        claimedUntil: new Date(Date.now() + 60_000),
      }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  test("rejects cross-tenant and wrong-amount charge attachments in SQL", async () => {
    await quoteAttempt();
    const crossTenant = await insertCharge({ organizationId: ORG_B });
    await expectDbCause(
      repository.attachCharge({
        key: createInput().key,
        organizationId: ORG_A,
        requestDigest: DIGEST,
        chargeId: crossTenant,
      }),
      "charge binding mismatch",
    );

    await dbWrite.execute(sql`DELETE FROM credit_transactions`);
    const wrongAmount = await insertCharge({ amount: "-1.00" });
    await expectDbCause(
      repository.attachCharge({
        key: createInput().key,
        organizationId: ORG_A,
        requestDigest: DIGEST,
        chargeId: wrongAmount,
      }),
      "charge binding mismatch",
    );
  });

  test("rejects NULL keys and every missing charge metadata binding in SQL", async () => {
    await quoteAttempt();
    const invalidCharges = [
      { stripePaymentIntentId: null },
      { metadata: { domain: "example.com", domainPurchaseKey: createInput().key } },
      { metadata: { type: "domain_purchase", domainPurchaseKey: createInput().key } },
      { metadata: { type: "domain_purchase", domain: "example.com" } },
    ];
    for (const invalid of invalidCharges) {
      const chargeId = await insertCharge(invalid);
      await expectDbCause(
        repository.attachCharge({
          key: createInput().key,
          organizationId: ORG_A,
          requestDigest: DIGEST,
          chargeId,
        }),
        "charge binding mismatch",
      );
      await dbWrite.execute(sql`DELETE FROM credit_transactions WHERE id = ${chargeId}`);
    }
  });

  test("rejects missing and malformed pinned charge totals before attachment", async () => {
    const input = createInput();
    await repository.createOrRead(input);
    const chargeId = await insertCharge();
    for (const [charge, fragment] of [
      [
        {
          wholesaleUsdCents: 1099,
          marginUsdCents: 400,
          registrationWholesaleUsdCents: 1099,
          renewalWholesaleUsdCents: 1099,
          renewalUsdCents: 1499,
          years: 1,
          currency: "USD",
        },
        "charge binding mismatch",
      ],
      [
        {
          ...QUOTE,
          totalUsdCents: "not-money",
        },
        "invalid input syntax for type numeric",
      ],
    ] as const) {
      await expectDbCause(
        dbWrite.execute(sql`
          UPDATE domain_purchase_idempotency
          SET status = 'charged', charge = ${JSON.stringify(charge)}::jsonb,
              charge_id = ${chargeId}
          WHERE key = ${input.key}
        `),
        fragment,
      );
    }
  });

  test("rejects NULL keys and every missing refund metadata binding in SQL", async () => {
    await quoteAttempt();
    const chargeId = await insertCharge();
    await repository.attachCharge({
      key: createInput().key,
      organizationId: ORG_A,
      requestDigest: DIGEST,
      chargeId,
    });
    const leaseToken = "30000000-0000-4000-8000-000000000009";
    await repository.claimRegistrarStart({
      key: createInput().key,
      organizationId: ORG_A,
      leaseToken,
      claimedUntil: new Date(Date.now() + 60_000),
    });
    await repository.markRefundPending({
      key: createInput().key,
      organizationId: ORG_A,
      leaseToken,
      errorCode: "registration_failed",
    });

    const invalidRefunds = [
      { stripePaymentIntentId: null },
      { metadata: { domain: "example.com", domainPurchaseKey: createInput().key } },
      { metadata: { type: "domain_purchase_refund", domainPurchaseKey: createInput().key } },
      { metadata: { type: "domain_purchase_refund", domain: "example.com" } },
      { amount: "1.00" },
    ];
    for (const invalid of invalidRefunds) {
      const refundId = await insertRefund(invalid);
      await expectDbCause(
        repository.markRefunded({
          key: createInput().key,
          organizationId: ORG_A,
          refundId,
          responseStatus: 502,
          responseBody: { success: false },
          replayUntil: new Date(Date.now() + 60_000),
        }),
        "refund binding mismatch",
      );
      await dbWrite.execute(sql`DELETE FROM credit_transactions WHERE id = ${refundId}`);
    }
  });

  test("surfaces an expired charged attempt to the durable reconciler", async () => {
    await quoteAttempt();
    const chargeId = await insertCharge();
    await repository.attachCharge({
      key: createInput().key,
      organizationId: ORG_A,
      requestDigest: DIGEST,
      chargeId,
    });
    await dbWrite.execute(sql`
      UPDATE domain_purchase_idempotency
      SET expires_at = now() - interval '1 second'
      WHERE key = ${createInput().key}
    `);

    const due = await repository.listDueReconciliation({
      now: new Date(),
      limit: 10,
    });
    expect(due).toHaveLength(1);
    expect(due[0]?.status).toBe("charged");
  });

  test("reclaims an expired provider lease once and binds the exact refund", async () => {
    await quoteAttempt();
    const chargeId = await insertCharge();
    await repository.attachCharge({
      key: createInput().key,
      organizationId: ORG_A,
      requestDigest: DIGEST,
      chargeId,
    });
    const firstLease = "30000000-0000-4000-8000-000000000001";
    await repository.claimRegistrarStart({
      key: createInput().key,
      organizationId: ORG_A,
      leaseToken: firstLease,
      claimedUntil: new Date(Date.now() - 1),
    });
    const reconciliationLease = "30000000-0000-4000-8000-000000000003";
    const reconciled = await repository.claimReconciliation({
      key: createInput().key,
      organizationId: ORG_A,
      leaseToken: reconciliationLease,
      now: new Date(),
      claimedUntil: new Date(Date.now() + 60_000),
    });
    expect(reconciled?.lease_token).toBe(reconciliationLease);
    await repository.markRefundPending({
      key: createInput().key,
      organizationId: ORG_A,
      leaseToken: reconciliationLease,
      errorCode: "registration_failed",
    });

    const refundRows = await dbWrite.execute(sql`
      INSERT INTO credit_transactions (
        organization_id, amount, type, metadata, stripe_payment_intent_id
      ) VALUES (
        ${ORG_A}, 14.99, 'refund',
        ${JSON.stringify({
          type: "domain_purchase_refund",
          domain: "example.com",
          domainPurchaseKey: `domain-buy:${ORG_A}:example.com`,
        })}::jsonb,
        ${`domain-purchase-refund:${ORG_A}:example.com`}
      ) RETURNING id
    `);
    const refundId = String((refundRows.rows[0] as { id: string }).id);
    const terminal = await repository.markRefunded({
      key: createInput().key,
      organizationId: ORG_A,
      refundId,
      responseStatus: 502,
      responseBody: { success: false, code: "registration_failed" },
      replayUntil: new Date(Date.now() + 60_000),
    });
    expect(terminal.status).toBe("refunded");
    expect(terminal.charge_id).toBe(chargeId);
    expect(terminal.refund_id).toBe(refundId);
  });

  test("binds completion to the exact tenant-owned managed domain", async () => {
    const attempt = await repository.createOrRead(createInput());
    const wrongDomainRows = await dbWrite.execute(sql`
      INSERT INTO managed_domains (organization_id, domain)
      VALUES (${ORG_A}, 'other.com')
      RETURNING id
    `);
    const wrongDomainId = String((wrongDomainRows.rows[0] as { id: string }).id);
    await expectDbCause(
      repository.complete({
        key: attempt.attempt.key,
        organizationId: ORG_A,
        managedDomainId: wrongDomainId,
        responseStatus: 200,
        responseBody: { success: true },
        replayUntil: new Date(Date.now() + 60_000),
      }),
      "managed-domain tenant/domain binding mismatch",
    );

    const correctRows = await dbWrite.execute(sql`
      INSERT INTO managed_domains (organization_id, domain)
      VALUES (${ORG_A}, 'example.com')
      RETURNING id
    `);
    const completed = await repository.complete({
      key: attempt.attempt.key,
      organizationId: ORG_A,
      managedDomainId: String((correctRows.rows[0] as { id: string }).id),
      responseStatus: 200,
      responseBody: { success: true },
      replayUntil: new Date(Date.now() + 60_000),
    });
    expect(completed.status).toBe("completed");
  });
});
