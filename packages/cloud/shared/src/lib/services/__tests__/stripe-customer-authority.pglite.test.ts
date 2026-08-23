/**
 * Proves durable Stripe Customer creation, crash recovery, and tenant fencing
 * against real PGlite transactions with a deterministic provider adapter.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { sqlRows } from "../../../db/execute-helpers";
import type {
  StripeCustomerCandidate,
  StripeCustomerLookup,
  StripeCustomerProvider,
} from "../stripe-customer-authority";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let AuthorityService: typeof import("../stripe-customer-authority").StripeCustomerAuthorityService;
let pglite: PGlite;

const isolatedAuthorityBase = `CREATE TABLE organizations (
  id uuid PRIMARY KEY, stripe_customer_id text, updated_at timestamptz NOT NULL DEFAULT now()
); CREATE TABLE auto_top_up_attempts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id),
  stripe_customer_id_snapshot text NOT NULL, provider_request_started_at timestamptz
)`;

class MockStripeCustomers implements StripeCustomerProvider {
  readonly candidates: StripeCustomerCandidate[] = [];
  createCalls = 0;
  retrieveCalls = 0;
  createDelayMs = 0;
  failSearchOnce = false;
  searchFailureReason = "search unavailable";
  throwAfterCreate = false;
  searchOverride?: (
    attemptId: string,
  ) => StripeCustomerCandidate[] | Promise<StripeCustomerCandidate[]>;
  forceCustomerId?: string;
  retrieveAbsentReason?: "missing" | "deleted";
  retrieveOverride?: (customerId: string) => StripeCustomerLookup;

  async searchByAttemptId(attemptId: string): Promise<StripeCustomerCandidate[]> {
    if (this.failSearchOnce) {
      this.failSearchOnce = false;
      throw new Error(this.searchFailureReason);
    }
    if (this.searchOverride) return await this.searchOverride(attemptId);
    return this.candidates.filter(
      (candidate) => candidate.metadata.eliza_customer_attempt_id === attemptId,
    );
  }

  async retrieve(customerId: string): Promise<StripeCustomerLookup> {
    this.retrieveCalls += 1;
    if (this.retrieveOverride) return this.retrieveOverride(customerId);
    if (this.retrieveAbsentReason) {
      return { kind: "absent", customerId, reason: this.retrieveAbsentReason };
    }
    const candidate = this.candidates.find((item) => item.id === customerId);
    return candidate
      ? { kind: "found", candidate }
      : { kind: "absent", customerId, reason: "missing" };
  }

  async create(
    params: { metadata?: Record<string, string> },
    _idempotencyKey: string,
  ): Promise<StripeCustomerCandidate> {
    this.createCalls += 1;
    if (this.createDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    const candidate = {
      id:
        this.forceCustomerId ??
        `cus_${params.metadata?.eliza_customer_attempt_id ?? this.createCalls}`,
      metadata: params.metadata ?? {},
      created: 1_700_000_000,
      livemode: false,
    };
    this.candidates.push(candidate);
    if (this.throwAfterCreate) {
      this.throwAfterCreate = false;
      throw new Error("connection lost after provider commit");
    }
    return candidate;
  }
}

beforeAll(async () => {
  process.env.DATABASE_URL = "pglite://memory";
  process.env.DISABLE_LOCAL_PGLITE_FALLBACK = "1";
  const client = await import("../../../db/client");
  dbWrite = client.dbWrite;
  closeDb = client.closeDatabaseConnectionsForTests;
  ({ StripeCustomerAuthorityService: AuthorityService } = await import(
    "../stripe-customer-authority"
  ));
  const testClient = client.getPgliteClientForTests();
  if (!testClient) throw new Error("PGlite test client was not initialized");
  pglite = testClient;
  await pglite.exec(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
      stripe_customer_id text, billing_email text, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX organizations_stripe_customer_authority_unique
      ON organizations(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
    CREATE TABLE auto_top_up_attempts (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id),
      stripe_customer_id_snapshot text NOT NULL,
      provider_request_started_at timestamptz
    );
  `);
  const migration = await Bun.file(
    new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
  ).text();
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
});

afterAll(async () => closeDb());

let orgSequence = 0;
async function organization(input?: { email?: string | null }): Promise<string> {
  orgSequence += 1;
  const suffix = String(orgSequence).padStart(12, "0");
  const id = `10000000-0000-4000-8000-${suffix}`;
  await dbWrite.execute(sql`INSERT INTO organizations (id, name, slug, billing_email)
    VALUES (${id}, ${`Org ${orgSequence}`}, ${`org-${orgSequence}`}, ${input?.email ?? null})`);
  return id;
}

async function legacyOrganization(provider: MockStripeCustomers): Promise<string> {
  const organizationId = await organization();
  const customerId = `cus_legacy_${orgSequence}`;
  provider.candidates.push({
    id: customerId,
    metadata: { organization_id: organizationId },
    created: 1_690_000_000,
    livemode: false,
  });
  await pglite.exec(
    "ALTER TABLE organizations DISABLE TRIGGER organization_stripe_customer_publication_guard",
  );
  await dbWrite.execute(
    sql`UPDATE organizations SET stripe_customer_id=${customerId} WHERE id=${organizationId}`,
  );
  await pglite.exec(
    "ALTER TABLE organizations ENABLE TRIGGER organization_stripe_customer_publication_guard",
  );
  await dbWrite.execute(sql`INSERT INTO stripe_customer_legacy_quarantines
    (organization_id, stripe_customer_id) VALUES (${organizationId}, ${customerId})`);
  return organizationId;
}

async function rows(organizationId: string) {
  return sqlRows<{
    status: string;
    provider_customer_id: string | null;
    provider_receipt: Record<string, unknown> | null;
    lease_token: string | null;
    ambiguous_reason: string | null;
  }>(
    dbWrite,
    sql`SELECT status, provider_customer_id, provider_receipt, lease_token, ambiguous_reason
      FROM stripe_customer_attempts WHERE organization_id=${organizationId}`,
  );
}

describe("Stripe Customer durable authority", () => {
  test("concurrent callers converge on one provider Customer and immutable receipt", async () => {
    const organizationId = await organization({ email: "billing@example.test" });
    const provider = new MockStripeCustomers();
    provider.createDelayMs = 75;
    const service = new AuthorityService(provider, { waitMs: 2_000 });
    const [paymentMethod, checkout] = await Promise.all([
      service.ensure({ organizationId, callerIntent: "payment_method" }),
      service.ensure({ organizationId, callerIntent: "interactive_checkout" }),
    ]);
    expect(paymentMethod).toBe(checkout);
    expect(provider.createCalls).toBe(1);
    expect(await rows(organizationId)).toEqual([
      expect.objectContaining({
        status: "bound",
        provider_customer_id: paymentMethod,
        lease_token: null,
        provider_receipt: expect.objectContaining({ customer_id: paymentMethod }),
      }),
    ]);
    await expect(
      pglite.exec(`UPDATE stripe_customer_attempts SET provider_customer_id='cus_changed'
        WHERE organization_id='${organizationId}'`),
    ).rejects.toThrow(/immutable authority/i);
    await expect(
      pglite.exec(`DELETE FROM stripe_customer_attempts WHERE organization_id='${organizationId}'`),
    ).rejects.toThrow(/cannot be removed/i);
    await expect(pglite.exec("TRUNCATE stripe_customer_attempts")).rejects.toThrow(
      /cannot be removed|referenced in a foreign key/i,
    );
  });

  test("recovers a provider success after the local response is lost", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.throwAfterCreate = true;
    const service = new AuthorityService(provider);
    await expect(
      service.ensure({ organizationId, callerIntent: "payment_method" }),
    ).rejects.toThrow("connection lost");
    expect((await rows(organizationId))[0]).toMatchObject({ status: "provider_ambiguous" });
    const recovered = await service.ensure({ organizationId, callerIntent: "credit_checkout" });
    expect(recovered).toBe(provider.candidates[0]?.id);
    expect(provider.createCalls).toBe(1);
  });

  test("bounds and sanitizes persisted provider ambiguity reasons", async () => {
    const fittingPair = `${"a".repeat(498)}💀`;
    const cases = [
      { reason: fittingPair, expected: fittingPair },
      { reason: `${"b".repeat(499)}💀`, expected: "b".repeat(499) },
      { reason: `${"c".repeat(499)}\uD83D`, expected: `${"c".repeat(499)}\uFFFD` },
    ];

    for (const { reason, expected } of cases) {
      const organizationId = await organization();
      const provider = new MockStripeCustomers();
      provider.failSearchOnce = true;
      provider.searchFailureReason = reason;
      const service = new AuthorityService(provider);

      await expect(
        service.ensure({ organizationId, callerIntent: "payment_method" }),
      ).rejects.toThrow();
      expect((await rows(organizationId))[0]?.ambiguous_reason).toBe(expected);
    }
  });

  test("reclaims a stale lease but not a live lease", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.failSearchOnce = true;
    let now = new Date("2026-08-19T00:00:00Z");
    const service = new AuthorityService(provider, { now: () => now, leaseMs: 100, waitMs: 0 });
    await expect(
      service.ensure({ organizationId, callerIntent: "payment_method" }),
    ).rejects.toThrow("search unavailable");
    await pglite.exec(`UPDATE stripe_customer_attempts SET status='provider_started',
      lease_token='30000000-0000-4000-8000-000000000001',
      lease_expires_at='2026-08-19T00:00:00.050Z' WHERE organization_id='${organizationId}'`);
    await expect(
      service.ensure({ organizationId, callerIntent: "credit_checkout" }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_ATTEMPT_BUSY" });
    now = new Date("2026-08-19T00:00:00.100Z");
    expect(await service.ensure({ organizationId, callerIntent: "credit_checkout" })).toBe(
      provider.candidates[0]?.id,
    );
  });

  test("after provider-key expiry reconciles metadata and never creates blindly", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.throwAfterCreate = true;
    let now = new Date("2026-08-19T00:00:00Z");
    const service = new AuthorityService(provider, { now: () => now });
    await expect(
      service.ensure({ organizationId, callerIntent: "interactive_checkout" }),
    ).rejects.toThrow("connection lost");
    now = new Date("2026-08-20T01:00:00Z");
    expect(await service.ensure({ organizationId, callerIntent: "interactive_checkout" })).toBe(
      provider.candidates[0]?.id,
    );
    expect(provider.createCalls).toBe(1);

    const absentOrganizationId = await organization();
    const absentProvider = new MockStripeCustomers();
    absentProvider.failSearchOnce = true;
    let absentNow = new Date("2026-08-19T00:00:00Z");
    const absentService = new AuthorityService(absentProvider, { now: () => absentNow });
    await expect(
      absentService.ensure({
        organizationId: absentOrganizationId,
        callerIntent: "payment_method",
      }),
    ).rejects.toThrow("search unavailable");
    absentNow = new Date("2026-08-20T01:00:00Z");
    await expect(
      absentService.ensure({
        organizationId: absentOrganizationId,
        callerIntent: "payment_method",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_RECONCILIATION_REQUIRED" });
    expect(absentProvider.createCalls).toBe(0);
  });

  test("fails closed on parameter drift, cross-tenant metadata, and duplicates", async () => {
    const driftOrg = await organization({ email: "first@example.test" });
    const driftProvider = new MockStripeCustomers();
    driftProvider.failSearchOnce = true;
    const driftService = new AuthorityService(driftProvider);
    await expect(
      driftService.ensure({ organizationId: driftOrg, callerIntent: "payment_method" }),
    ).rejects.toThrow("search unavailable");
    await dbWrite.execute(
      sql`UPDATE organizations SET billing_email='changed@example.test' WHERE id=${driftOrg}`,
    );
    await expect(
      driftService.ensure({ organizationId: driftOrg, callerIntent: "payment_method" }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_REQUEST_DRIFT" });

    for (const mode of ["cross-tenant", "duplicates"] as const) {
      const organizationId = await organization();
      const provider = new MockStripeCustomers();
      provider.searchOverride = (attemptId) => {
        const metadata = {
          organization_id: mode === "cross-tenant" ? driftOrg : organizationId,
          eliza_organization_id: mode === "cross-tenant" ? driftOrg : organizationId,
          eliza_customer_attempt_id: attemptId,
          eliza_customer_generation: "1",
          eliza_customer_request_digest: "wrong",
          eliza_customer_provider: "stripe",
        };
        const first = { id: "cus_conflict_a", metadata, created: 1, livemode: false };
        return mode === "duplicates" ? [first, { ...first, id: "cus_conflict_b" }] : [first];
      };
      const service = new AuthorityService(provider);
      await expect(
        service.ensure({ organizationId, callerIntent: "credit_checkout" }),
      ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_QUARANTINED" });
      expect((await rows(organizationId))[0]).toMatchObject({ status: "quarantined" });
    }
  });

  test("one provider Customer cannot bind two organizations", async () => {
    const orgA = await organization();
    const orgB = await organization();
    const providerA = new MockStripeCustomers();
    providerA.forceCustomerId = "cus_shared";
    const providerB = new MockStripeCustomers();
    providerB.forceCustomerId = "cus_shared";
    expect(
      await new AuthorityService(providerA).ensure({
        organizationId: orgA,
        callerIntent: "payment_method",
      }),
    ).toBe("cus_shared");
    await expect(
      new AuthorityService(providerB).ensure({
        organizationId: orgB,
        callerIntent: "interactive_checkout",
      }),
    ).rejects.toThrow();
    const orgBRows = await sqlRows<{ stripe_customer_id: string | null }>(
      dbWrite,
      sql`SELECT stripe_customer_id FROM organizations WHERE id=${orgB}`,
    );
    expect(orgBRows).toEqual([{ stripe_customer_id: null }]);
  });

  test("provider-verifies and audits a quarantined legacy Customer before reuse", async () => {
    const provider = new MockStripeCustomers();
    const organizationId = await legacyOrganization(provider);
    const service = new AuthorityService(provider);
    const customerId = await service.ensure({
      organizationId,
      callerIntent: "payment_method",
    });
    expect(customerId).toBe(provider.candidates[0]?.id);
    expect(provider.retrieveCalls).toBe(1);
    expect(provider.createCalls).toBe(0);
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT resolved_attempt_id, resolved_by, resolution_reason
          FROM stripe_customer_legacy_quarantines WHERE organization_id=${organizationId}`,
      ),
    ).toEqual([
      expect.objectContaining({
        resolved_attempt_id: expect.any(String),
        resolved_by: "system:stripe-customer-authority",
        resolution_reason: "provider-verified legacy Customer tenant metadata",
      }),
    ]);
    expect((await rows(organizationId))[0]?.provider_receipt).toEqual(
      expect.objectContaining({
        binding_kind: "legacy_verified",
        metadata: { organization_id: organizationId },
      }),
    );
    expect(await service.ensure({ organizationId, callerIntent: "interactive_checkout" })).toBe(
      customerId,
    );
    expect(provider.retrieveCalls).toBe(1);
    await expect(
      Promise.resolve(
        dbWrite.execute(
          sql`UPDATE organizations SET stripe_customer_id=NULL WHERE id=${organizationId}`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        dbWrite.execute(sql`UPDATE stripe_customer_legacy_quarantines
        SET retirement_kind='missing' WHERE organization_id=${organizationId}`),
      ),
    ).rejects.toThrow();
  });

  test("provider-verified missing, deleted, and wrong-tenant legacy Customers are retired once", async () => {
    for (const mode of ["wrong_tenant", "missing", "deleted"] as const) {
      const provider = new MockStripeCustomers();
      const organizationId = await legacyOrganization(provider);
      const oldCustomerId = provider.candidates[0]?.id;
      if (!oldCustomerId) throw new Error("missing legacy fixture");
      if (mode === "wrong_tenant" && provider.candidates[0]) {
        provider.candidates[0].metadata.organization_id = "10000000-0000-4000-8000-999999999999";
      } else {
        provider.retrieveAbsentReason = mode;
      }
      const service = new AuthorityService(provider);
      const replacement = await service.ensure({
        organizationId,
        callerIntent: "credit_checkout",
      });
      expect(replacement).not.toBe(oldCustomerId);
      expect(provider.createCalls).toBe(1);
      expect(
        await sqlRows(
          dbWrite,
          sql`SELECT resolved_attempt_id, retirement_kind, retirement_receipt,
            replacement_attempt_id FROM stripe_customer_legacy_quarantines
            WHERE organization_id=${organizationId}`,
        ),
      ).toEqual([
        expect.objectContaining({
          resolved_attempt_id: expect.any(String),
          retirement_kind: mode,
          replacement_attempt_id: expect.any(String),
          retirement_receipt: expect.objectContaining({
            customer_id: oldCustomerId,
            outcome: mode,
          }),
        }),
      ]);
      expect(
        await sqlRows(
          dbWrite,
          sql`SELECT generation, status FROM stripe_customer_attempts
            WHERE organization_id=${organizationId} ORDER BY generation`,
        ),
      ).toEqual([
        { generation: 1, status: "abandoned" },
        { generation: 2, status: "bound" },
      ]);
      expect(await service.ensure({ organizationId, callerIntent: "payment_method" })).toBe(
        replacement,
      );
    }
  });

  test("an attacker Customer returned for an exact legacy lookup cannot trigger replacement", async () => {
    const provider = new MockStripeCustomers();
    const organizationId = await legacyOrganization(provider);
    provider.retrieveOverride = () => ({
      kind: "found",
      candidate: {
        id: "cus_attacker",
        metadata: { organization_id: "10000000-0000-4000-8000-999999999999" },
        created: 1,
        livemode: false,
      },
    });
    await expect(
      new AuthorityService(provider).ensure({
        organizationId,
        callerIntent: "interactive_checkout",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_QUARANTINED" });
    expect(provider.createCalls).toBe(0);
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT resolved_attempt_id FROM stripe_customer_legacy_quarantines
          WHERE organization_id=${organizationId}`,
      ),
    ).toEqual([{ resolved_attempt_id: null }]);
  });

  test("concurrent legacy retirement and rebind converges on one replacement generation", async () => {
    const provider = new MockStripeCustomers();
    const organizationId = await legacyOrganization(provider);
    provider.retrieveAbsentReason = "deleted";
    provider.createDelayMs = 50;
    const service = new AuthorityService(provider, { waitMs: 2_000 });
    const [paymentMethodCustomer, checkoutCustomer] = await Promise.all([
      service.ensure({ organizationId, callerIntent: "payment_method" }),
      service.ensure({ organizationId, callerIntent: "interactive_checkout" }),
    ]);
    expect(paymentMethodCustomer).toBe(checkoutCustomer);
    expect(provider.createCalls).toBe(1);
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT count(*)::integer AS count FROM stripe_customer_attempts
          WHERE organization_id=${organizationId}`,
      ),
    ).toEqual([{ count: 2 }]);
  });

  test("audited no-candidate resolution abandons once and creates one new generation", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.failSearchOnce = true;
    let now = new Date("2026-08-19T00:00:00Z");
    const service = new AuthorityService(provider, { now: () => now });
    await expect(
      service.ensure({ organizationId, callerIntent: "payment_method" }),
    ).rejects.toThrow("search unavailable");
    const [attempt] = await sqlRows<{ id: string }>(
      dbWrite,
      sql`SELECT id FROM stripe_customer_attempts WHERE organization_id=${organizationId}`,
    );
    if (!attempt) throw new Error("missing attempt");
    await expect(
      service.resolve({
        organizationId,
        attemptId: attempt.id,
        actor: "billing-operator@example.test",
        reason: "provider search found no Customer after bounded recovery",
        action: "bind_unique_candidate",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_RESOLUTION_NO_CANDIDATE" });
    now = new Date("2026-08-20T01:00:00Z");
    const resolved = await service.resolve({
      organizationId,
      attemptId: attempt.id,
      actor: "billing-operator@example.test",
      reason: "provider search found no Customer after bounded recovery",
      action: "abandon_and_retry",
    });
    const replay = await service.resolve({
      organizationId,
      attemptId: attempt.id,
      actor: "billing-operator@example.test",
      reason: "provider search found no Customer after bounded recovery",
      action: "abandon_and_retry",
    });
    expect(replay).toEqual(resolved);
    await expect(
      service.resolve({
        organizationId,
        attemptId: attempt.id,
        actor: "different-operator@example.test",
        reason: "different replay authority",
        action: "abandon_and_retry",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_RESOLUTION_NOT_LATEST" });
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT generation, status, resolved_by, resolution_reason
        FROM stripe_customer_attempts WHERE organization_id=${organizationId} ORDER BY generation`,
      ),
    ).toEqual([
      expect.objectContaining({
        generation: 1,
        status: "abandoned",
        resolved_by: "billing-operator@example.test",
      }),
      expect.objectContaining({ generation: 2, status: "prepared" }),
    ]);
  });

  test("audited resolution rejects duplicate verified candidates", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.failSearchOnce = true;
    const service = new AuthorityService(provider);
    await expect(
      service.ensure({ organizationId, callerIntent: "credit_checkout" }),
    ).rejects.toThrow("search unavailable");
    const [attempt] = await sqlRows<{
      id: string;
      generation: number;
      request_digest: string;
    }>(
      dbWrite,
      sql`SELECT id, generation, request_digest FROM stripe_customer_attempts
      WHERE organization_id=${organizationId}`,
    );
    if (!attempt) throw new Error("missing attempt");
    const metadata = {
      organization_id: organizationId,
      eliza_organization_id: organizationId,
      eliza_customer_attempt_id: attempt.id,
      eliza_customer_generation: String(attempt.generation),
      eliza_customer_request_digest: attempt.request_digest,
      eliza_customer_provider: "stripe",
    };
    provider.candidates.push(
      { id: "cus_duplicate_a", metadata, created: 1, livemode: false },
      { id: "cus_duplicate_b", metadata, created: 2, livemode: false },
    );
    await expect(
      service.resolve({
        organizationId,
        attemptId: attempt.id,
        actor: "billing-operator@example.test",
        reason: "manual duplicate investigation",
        action: "bind_unique_candidate",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_RESOLUTION_DUPLICATE" });
    expect((await rows(organizationId))[0]).toMatchObject({ status: "provider_ambiguous" });
  });

  test("audited resolution performs provider search outside its database locks", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.failSearchOnce = true;
    const service = new AuthorityService(provider);
    await expect(
      service.ensure({ organizationId, callerIntent: "payment_method" }),
    ).rejects.toThrow("search unavailable");
    const [attempt] = await sqlRows<{ id: string }>(
      dbWrite,
      sql`SELECT id FROM stripe_customer_attempts WHERE organization_id=${organizationId}`,
    );
    if (!attempt) throw new Error("missing attempt");
    let updateFinished = false;
    provider.searchOverride = () => [];
    const originalSearch = provider.searchByAttemptId.bind(provider);
    provider.searchByAttemptId = async (attemptId) => {
      await Promise.race([
        dbWrite
          .execute(sql`UPDATE organizations SET name=name WHERE id=${organizationId}`)
          .then(() => {
            updateFinished = true;
          }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("provider callback blocked on database lock")), 500),
        ),
      ]);
      return originalSearch(attemptId);
    };
    await expect(
      service.resolve({
        organizationId,
        attemptId: attempt.id,
        actor: "billing-operator@example.test",
        reason: "prove provider lookup is outside locks",
        action: "bind_unique_candidate",
      }),
    ).rejects.toMatchObject({ code: "STRIPE_CUSTOMER_RESOLUTION_NO_CANDIDATE" });
    expect(updateFinished).toBe(true);
  });

  test("concurrent audited resolutions are fenced by one durable lease", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.failSearchOnce = true;
    const service = new AuthorityService(provider, { leaseMs: 5_000 });
    await expect(
      service.ensure({ organizationId, callerIntent: "payment_method" }),
    ).rejects.toThrow("search unavailable");
    const [attempt] = await sqlRows<{ id: string }>(
      dbWrite,
      sql`SELECT id FROM stripe_customer_attempts WHERE organization_id=${organizationId}`,
    );
    if (!attempt) throw new Error("missing attempt");
    let releaseSearch: (() => void) | undefined;
    const searchEntered = new Promise<void>((resolve) => {
      provider.searchOverride = async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseSearch = release;
        });
        return [];
      };
    });
    const input = {
      organizationId,
      attemptId: attempt.id,
      actor: "billing-operator@example.test",
      reason: "concurrent resolution fence proof",
      action: "bind_unique_candidate" as const,
    };
    const first = service.resolve(input);
    await searchEntered;
    await expect(service.resolve(input)).rejects.toMatchObject({
      code: "STRIPE_CUSTOMER_RESOLUTION_BUSY",
    });
    releaseSearch?.();
    await expect(first).rejects.toMatchObject({
      code: "STRIPE_CUSTOMER_RESOLUTION_NO_CANDIDATE",
    });
    expect((await rows(organizationId))[0]?.lease_token).toBeNull();
  });

  test("audited resolution binds one verified candidate and replays exactly", async () => {
    const organizationId = await organization();
    const provider = new MockStripeCustomers();
    provider.throwAfterCreate = true;
    const service = new AuthorityService(provider);
    await expect(
      service.ensure({ organizationId, callerIntent: "interactive_checkout" }),
    ).rejects.toThrow("connection lost");
    const [attempt] = await sqlRows<{ id: string }>(
      dbWrite,
      sql`SELECT id FROM stripe_customer_attempts WHERE organization_id=${organizationId}`,
    );
    if (!attempt) throw new Error("missing attempt");
    const input = {
      organizationId,
      attemptId: attempt.id,
      actor: "billing-operator@example.test",
      reason: "verified the sole provider Customer",
      action: "bind_unique_candidate" as const,
    };
    const resolved = await service.resolve(input);
    expect(await service.resolve(input)).toEqual(resolved);
    expect((await rows(organizationId))[0]).toMatchObject({
      status: "bound",
      provider_customer_id: resolved.customerId,
    });
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT stripe_customer_id FROM organizations WHERE id=${organizationId}`,
      ),
    ).toEqual([{ stripe_customer_id: resolved.customerId }]);
  });

  test("organization publication rejects out-of-band, null, and divergent mutations", async () => {
    const unbound = await organization();
    await expect(
      Promise.resolve(
        dbWrite.execute(
          sql`UPDATE organizations SET stripe_customer_id='cus_out_of_band' WHERE id=${unbound}`,
        ),
      ),
    ).rejects.toThrow();
    const bound = await organization();
    const customerId = await new AuthorityService(new MockStripeCustomers()).ensure({
      organizationId: bound,
      callerIntent: "payment_method",
    });
    await dbWrite.execute(
      sql`UPDATE organizations SET stripe_customer_id=${customerId} WHERE id=${bound}`,
    );
    await expect(
      Promise.resolve(
        dbWrite.execute(sql`UPDATE organizations SET stripe_customer_id=NULL WHERE id=${bound}`),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        dbWrite.execute(
          sql`UPDATE organizations SET stripe_customer_id='cus_other' WHERE id=${bound}`,
        ),
      ),
    ).rejects.toThrow();
  });

  test("database rejects forged initial states and non-allowlisted bound receipts", async () => {
    const organizationId = await organization();
    const maliciousId = "70000000-0000-4000-8000-000000000001";
    await expect(
      pglite.exec(`INSERT INTO stripe_customer_attempts
        (id, organization_id, generation, request_digest, caller_intent, idempotency_key,
         status, provider_started_at)
        VALUES ('${maliciousId}', '${organizationId}', 1, '${"a".repeat(64)}',
          'payment_method', 'eliza-customer-attempt:${maliciousId}', 'provider_started', now())`),
    ).rejects.toThrow(/exact prepared authority/i);

    const attemptId = "70000000-0000-4000-8000-000000000002";
    await pglite.exec(`INSERT INTO stripe_customer_attempts
      (id, organization_id, generation, request_digest, caller_intent, idempotency_key, status)
      VALUES ('${attemptId}', '${organizationId}', 1, '${"b".repeat(64)}', 'payment_method',
        'eliza-customer-attempt:${attemptId}', 'prepared')`);
    await pglite.exec(`UPDATE stripe_customer_attempts SET status='provider_started',
      provider_started_at=now() WHERE id='${attemptId}'`);
    await expect(
      pglite.exec(`UPDATE stripe_customer_attempts SET status='bound',
        provider_customer_id='cus_forged', provider_livemode=false, bound_at=now(),
        provider_receipt='{"customer_id":"cus_forged","created":1,"livemode":false,
          "binding_kind":"attempt_created","metadata":{},"extra":"not-allowed"}'::jsonb
        WHERE id='${attemptId}'`),
    ).rejects.toThrow(/receipt is not exact/i);
  });

  test("migration replay preserves bound authority and does not quarantine new receipts", async () => {
    const organizationId = await organization();
    const customerId = await new AuthorityService(new MockStripeCustomers()).ensure({
      organizationId,
      callerIntent: "payment_method",
    });
    const migration = await Bun.file(
      new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
    ).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT stripe_customer_id FROM organizations WHERE id=${organizationId}`,
      ),
    ).toEqual([{ stripe_customer_id: customerId }]);
    expect(
      await sqlRows(
        dbWrite,
        sql`SELECT organization_id FROM stripe_customer_legacy_quarantines
        WHERE organization_id=${organizationId}`,
      ),
    ).toEqual([]);
  });

  test("migration rejects a same-name index collision instead of accepting partial authority", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(isolatedAuthorityBase);
      const migration = await Bun.file(
        new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
      ).text();
      const statements = migration.split("--> statement-breakpoint").filter((item) => item.trim());
      if (!statements[0]) throw new Error("migration has no table statement");
      await isolated.exec(statements[0]);
      await isolated.exec(`CREATE UNIQUE INDEX stripe_customer_attempts_org_generation_idx
        ON stripe_customer_attempts (id)`);
      await expect(
        (async () => {
          for (const statement of statements) await isolated.exec(statement);
        })(),
      ).rejects.toThrow(/index collision/i);
    } finally {
      await isolated.close();
    }
  });

  test("migration replay rejects a missing authority postcondition", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(isolatedAuthorityBase);
      const migration = await Bun.file(
        new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
      ).text();
      const statements = migration.split("--> statement-breakpoint").filter((item) => item.trim());
      for (const statement of statements) await isolated.exec(statement);
      await isolated.exec(`ALTER TABLE stripe_customer_attempts
        DROP CONSTRAINT stripe_customer_attempts_generation_check`);
      await expect(
        (async () => {
          for (const statement of statements) await isolated.exec(statement);
        })(),
      ).rejects.toThrow(/constraint collision/i);
    } finally {
      await isolated.close();
    }
  });

  test("migration rejects an unexpected non-nullability-independent constraint", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(isolatedAuthorityBase);
      const migration = await Bun.file(
        new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
      ).text();
      const statements = migration.split("--> statement-breakpoint").filter((item) => item.trim());
      for (const statement of statements) await isolated.exec(statement);
      await isolated.exec(`ALTER TABLE stripe_customer_attempts
        ADD CONSTRAINT stripe_customer_attempts_unexpected_check CHECK (generation < 1000000)`);
      const postcondition = statements.at(-1);
      if (!postcondition) throw new Error("migration has no postcondition");
      await expect(isolated.exec(postcondition)).rejects.toThrow(/constraint collision/i);
    } finally {
      await isolated.close();
    }
  });

  test("catalog postcondition rejects weakened checks, predicates, FKs, columns, defaults, and triggers", async () => {
    const cases = [
      `ALTER TABLE stripe_customer_attempts DROP CONSTRAINT stripe_customer_attempts_generation_check;
       ALTER TABLE stripe_customer_attempts ADD CONSTRAINT stripe_customer_attempts_generation_check
         CHECK (generation >= 0)`,
      `DROP INDEX stripe_customer_attempts_active_org_idx;
       CREATE UNIQUE INDEX stripe_customer_attempts_active_org_idx ON stripe_customer_attempts
         (organization_id) WHERE status IN ('prepared','provider_started')`,
      `ALTER TABLE stripe_customer_legacy_quarantines
         DROP CONSTRAINT stripe_customer_legacy_quarantine_replacement_tenant_fk;
       ALTER TABLE stripe_customer_legacy_quarantines
         ADD CONSTRAINT stripe_customer_legacy_quarantine_replacement_tenant_fk
         FOREIGN KEY (replacement_attempt_id) REFERENCES stripe_customer_attempts(id) ON DELETE RESTRICT`,
      `ALTER TABLE stripe_customer_legacy_quarantines
         ALTER COLUMN retirement_kind TYPE varchar(32)`,
      `ALTER TABLE stripe_customer_attempts ALTER COLUMN status SET DEFAULT 'provider_started'`,
      `DROP TRIGGER stripe_customer_attempt_authority_guard ON stripe_customer_attempts;
       CREATE TRIGGER stripe_customer_attempt_authority_guard AFTER INSERT OR UPDATE
         ON stripe_customer_attempts FOR EACH ROW
         EXECUTE FUNCTION guard_stripe_customer_attempt_authority()`,
      `DROP TRIGGER auto_top_up_stripe_customer_authority_guard ON auto_top_up_attempts;
       CREATE TRIGGER auto_top_up_stripe_customer_authority_guard AFTER INSERT OR UPDATE
         ON auto_top_up_attempts FOR EACH ROW
         EXECUTE FUNCTION guard_auto_top_up_stripe_customer_authority()`,
    ];
    for (const mutation of cases) {
      const isolated = new PGlite();
      try {
        await isolated.exec(isolatedAuthorityBase);
        const migration = await Bun.file(
          new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
        ).text();
        const statements = migration
          .split("--> statement-breakpoint")
          .filter((item) => item.trim());
        for (const statement of statements) await isolated.exec(statement);
        await isolated.exec(mutation);
        const postcondition = statements.at(-1);
        if (!postcondition) throw new Error("migration has no postcondition");
        await expect(isolated.exec(postcondition)).rejects.toThrow(/collision/i);
      } finally {
        await isolated.close();
      }
    }
  });

  test("migration fails closed on a partial authority table object", async () => {
    const isolated = new PGlite();
    try {
      await isolated.exec(`${isolatedAuthorityBase};
        CREATE TABLE stripe_customer_attempts (id uuid PRIMARY KEY)`);
      const migration = await Bun.file(
        new URL("../../../db/migrations/0267_stripe_customer_attempts.sql", import.meta.url),
      ).text();
      await expect(
        (async () => {
          for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await isolated.exec(statement);
          }
        })(),
      ).rejects.toThrow();
    } finally {
      await isolated.close();
    }
  });
});
