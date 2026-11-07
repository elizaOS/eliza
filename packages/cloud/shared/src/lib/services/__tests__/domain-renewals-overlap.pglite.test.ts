/**
 * Two domain-renewal runs that overlap (the scheduled run and a manual
 * trigger) charge a renewal period once. Real credits service and ledger on
 * PGlite; the registrar, the managed-domain store and the account lifecycle
 * check are replaced. The second run starts right after the first one has
 * checked whether the period was already charged.
 */
import { afterAll, beforeAll, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG = randomUUID();
const DOMAIN_ID = randomUUID();
const EXPIRES_AT = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const domain = {
  id: DOMAIN_ID,
  organizationId: ORG,
  domain: "acme.example",
  registrar: "cloudflare",
  autoRenew: true,
  expiresAt: EXPIRES_AT,
  renewalPrice: 1500,
};
const registrarCalls: string[] = [];
let registrarFails = false;
let registrarExpiry: Date | null = null;
const recordedExpiries: Date[] = [];

const realLifecycle = { ...(await import("../account-lifecycle-authority")) };
const realManagedDomains = { ...(await import("../managed-domains")) };
const realRegistrar = { ...(await import("../cloudflare-registrar")) };
mock.module("../account-lifecycle-authority", () => ({
  ...realLifecycle,
  requireActiveOrganizationLifecycle: async () => ({ revision: 1 }),
}));
mock.module("../managed-domains", () => ({
  ...realManagedDomains,
  managedDomainsService: {
    listCloudflareRenewalsDue: async () => [domain],
    recordRenewal: async (_id: string, expiresAt: Date) => {
      recordedExpiries.push(expiresAt);
    },
    setAutoRenew: async () => undefined,
  },
}));
mock.module("../cloudflare-registrar", () => ({
  ...realRegistrar,
  cloudflareRegistrarService: {
    renewDomain: async (name: string) => {
      registrarCalls.push(name);
      if (registrarFails) throw new Error("registrar unavailable");
      return {
        expiresAt: (
          registrarExpiry ?? new Date(EXPIRES_AT.getTime() + 365 * 86_400_000)
        ).toISOString(),
      };
    },
    setDomainAutoRenew: async () => undefined,
  },
}));

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
  "../../../db/client"
);
const schemas = await import("../../../db/schemas");
const { creditTransactionsRepository } = await import(
  "../../../db/repositories/credit-transactions"
);
const { processDomainRenewals } = await import("../domain-renewals");

const pg = () => getPgliteClientForTests();
const TABLES = [
  "organizations",
  "creditTransactions",
  "billingSubscriptions",
  "organizationSubscriptionAuthorities",
  "orgRateLimitOverrides",
  "organizationConfig",
  "orgStorageQuota",
  "organizationPaymentReversalHolds",
  "autoTopUpAttempts",
] as const;
const SEEDED = new Set([
  "organizations",
  "credit_transactions",
  "billing_subscriptions",
  "organization_subscription_authorities",
  "org_rate_limit_overrides",
  "organization_config",
  "org_storage_quota",
  "organization_payment_reversal_holds",
  "auto_top_up_attempts",
]);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(Object.fromEntries(TABLES.map((name) => [name, schemas[name]])), empty.id),
  )) {
    // Keys into tables outside this slice of the schema are not created.
    const foreignKey = statement.match(/REFERENCES "([a-z_]+)"/);
    if (foreignKey && !SEEDED.has(foreignKey[1])) continue;
    await pg().exec(statement.replaceAll('"public".', ""));
  }
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Acme',$2,'100')",
    [ORG, `acme-${ORG}`],
  );
  await pg().query(
    "INSERT INTO organization_subscription_authorities(organization_id,state,policy_generation) VALUES ($1,'none',1)",
    [ORG],
  );
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("a run that overlaps another charges the renewal period once", async () => {
  const original = creditTransactionsRepository.getDomainRenewalCharges.bind(
    creditTransactionsRepository,
  );
  let overlapping: ReturnType<typeof processDomainRenewals> | null = null;
  const spy = spyOn(creditTransactionsRepository, "getDomainRenewalCharges").mockImplementation(
    async (...args) => {
      const charges = await original(...args);
      if (!overlapping) {
        // The second run starts now and completes before this one debits.
        overlapping = processDomainRenewals();
        await overlapping;
      }
      return charges;
    },
  );
  let first: Awaited<ReturnType<typeof processDomainRenewals>>;
  try {
    first = await processDomainRenewals();
  } finally {
    spy.mockRestore();
  }
  const second = await (overlapping as unknown as ReturnType<typeof processDomainRenewals>);

  const debits = await pg().query<{ amount: string }>(
    "SELECT amount FROM credit_transactions WHERE organization_id=$1 AND metadata->>'type'='domain_renewal'",
    [ORG],
  );
  const balance = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [ORG],
  );
  expect(debits.rows).toHaveLength(1);
  expect(Number(balance.rows[0]?.credit_balance)).toBeCloseTo(85, 6);
  expect(registrarCalls).toEqual(["acme.example"]);
  expect([...first.results, ...second.results].map((r) => r.outcome).sort()).toEqual([
    "already_charged",
    "renewed",
  ]);
});

test("a period refunded after a registrar failure is charged again on the next run", async () => {
  await pg().query("DELETE FROM credit_transactions WHERE organization_id=$1", [ORG]);
  await pg().query("UPDATE organizations SET credit_balance='100' WHERE id=$1", [ORG]);
  domain.expiresAt = new Date(EXPIRES_AT.getTime() + 60_000); // a new period
  registrarFails = true;
  const failed = await processDomainRenewals();
  registrarFails = false;
  const retried = await processDomainRenewals();

  expect(failed.results.map((r) => r.outcome)).toEqual(["registrar_failed"]);
  expect(retried.results.map((r) => r.outcome)).toEqual(["renewed"]);
  const rows = await pg().query<{ type: string }>(
    "SELECT metadata->>'type' AS type FROM credit_transactions WHERE organization_id=$1 ORDER BY created_at",
    [ORG],
  );
  expect(rows.rows.map((row) => row.type)).toEqual([
    "domain_renewal",
    "domain_renewal_refund",
    "domain_renewal",
  ]);
  const balance = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [ORG],
  );
  expect(Number(balance.rows[0]?.credit_balance)).toBeCloseTo(85, 6);
});

test("a renewal records the paid period while Cloudflare still shows the old expiry", async () => {
  await pg().query("DELETE FROM credit_transactions WHERE organization_id=$1", [ORG]);
  await pg().query("UPDATE organizations SET credit_balance='100' WHERE id=$1", [ORG]);
  domain.expiresAt = new Date(EXPIRES_AT.getTime() + 120_000); // a new period
  // Cloudflare renews near expiry, so right after auto-renew is turned on its
  // registration still reports the current expiry.
  registrarExpiry = domain.expiresAt;
  recordedExpiries.length = 0;
  const run = await processDomainRenewals();
  registrarExpiry = null;

  expect(run.results.map((r) => r.outcome)).toEqual(["renewed"]);
  expect(recordedExpiries).toHaveLength(1);
  expect(recordedExpiries[0]?.getTime()).toBeGreaterThan(domain.expiresAt.getTime());
});
