/**
 * Real-DB coverage for the domain renewal-billing cron (#10245) and the custom-
 * domain health probe (#10244).
 *
 * Renewals run the REAL credit deduct/refund SQL against in-process PGlite and
 * the REAL registrar service in dev-stub mode (no live Cloudflare). They assert
 * the observable DB effects — the org's balance moves, the ledger gets exactly
 * one `domain_renewal` debit, the expiry advances — and the fail-closed
 * behaviors: idempotent per (domain, period), declined-debit lapses the domain,
 * registrar-failure refunds exactly once.
 *
 * Health probes mock only `safeFetch` (the outbound network), running the real
 * `is_live` sync against PGlite.
 *
 * Fails loudly (via the `pgliteReady` guard) if PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";
process.env.ELIZA_CF_REGISTRAR_DEV_STUB = "1";

// Non-billing fire-and-forget side-effects of the success path — NOT under test.
mock.module("../email", () => ({
  emailService: { sendLowCreditsEmail: mock(async () => false) },
}));
mock.module("../waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("../auto-top-up", () => ({
  autoTopUpService: { executeAutoTopUp: mock(async () => undefined) },
}));

// Outbound network for the health probe (path resolves to lib/security/safe-fetch).
const safeFetchMock = mock<(url: string, init?: RequestInit) => Promise<Response>>();
mock.module("../../security/safe-fetch", () => ({ safeFetch: safeFetchMock }));

// Generous: the cold-compile of the real credits + db-client import graph this
// suite pulls in can take ~30s before the DDL even runs.
const PGLITE_TIMEOUT = 180000;
const ORG = "00000000-0000-0000-0000-0000000000e1";
const DOMAIN_ID = "00000000-0000-0000-0000-0000000000e2";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let domainRenewalsService: typeof import("../domain-renewals").domainRenewalsService;
let domainHealthService: typeof import("../domain-health").domainHealthService;
let pgliteReady = true;

async function seedOrg(balance: string): Promise<void> {
  await dbWrite.execute(`DELETE FROM credit_transactions;`);
  await dbWrite.execute(`DELETE FROM organizations;`);
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug, credit_balance, pay_as_you_go_from_earnings, is_active)
     VALUES ('${ORG}', 'Acme', 'acme-${ORG}', '${balance}', true, true);`,
  );
}

interface SeedDomainOpts {
  domain?: string;
  expiresInDays?: number;
  renewalPriceCents?: number;
  autoRenew?: boolean;
  isLive?: boolean;
  status?: string;
  verified?: boolean;
  registrar?: string;
}

async function seedDomain(opts: SeedDomainOpts = {}): Promise<void> {
  const {
    domain = "renew-me.com",
    expiresInDays = 7,
    renewalPriceCents = 1099,
    autoRenew = true,
    isLive = false,
    status = "active",
    verified = true,
    registrar = "cloudflare",
  } = opts;
  await dbWrite.execute(`DELETE FROM managed_domains;`);
  const expiresAt = new Date(Date.now() + expiresInDays * 86400000).toISOString();
  await dbWrite.execute(
    `INSERT INTO managed_domains
       (id, organization_id, domain, registrar, status, auto_renew, expires_at,
        renewal_price, is_live, verified)
     VALUES
       ('${DOMAIN_ID}', '${ORG}', '${domain}', '${registrar}', '${status}',
        ${autoRenew}, '${expiresAt}', '${renewalPriceCents}', ${isLive}, ${verified});`,
  );
}

async function readBalance(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${ORG}';`,
  );
  return Number((rows.rows[0] as { credit_balance: string }).credit_balance);
}

async function readDomain(): Promise<{
  auto_renew: boolean;
  is_live: boolean;
  expires_at: string;
  health_check_error: string | null;
}> {
  const rows = await dbWrite.execute(
    `SELECT auto_renew, is_live, expires_at, health_check_error FROM managed_domains WHERE id = '${DOMAIN_ID}';`,
  );
  return rows.rows[0] as never;
}

async function countRenewalDebits(): Promise<number> {
  const rows = await dbWrite.execute(
    `SELECT count(*)::int AS n FROM credit_transactions WHERE metadata->>'type' = 'domain_renewal';`,
  );
  return Number((rows.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ domainRenewalsService } = await import("../domain-renewals"));
    ({ domainHealthService } = await import("../domain-health"));

    const ddl = [
      `CREATE TABLE IF NOT EXISTS organizations (
        id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL,
        credit_balance numeric(12,6) NOT NULL DEFAULT '0', settings jsonb DEFAULT '{}',
        stripe_customer_id text, billing_email text, stripe_payment_method_id text,
        stripe_default_payment_method text, auto_top_up_enabled boolean DEFAULT false,
        auto_top_up_threshold numeric(10,2), auto_top_up_amount numeric(10,2),
        pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true,
        steward_tenant_id text, steward_tenant_api_key text,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS credit_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        user_id uuid, amount numeric(12,6) NOT NULL, type text NOT NULL, description text,
        metadata jsonb NOT NULL DEFAULT '{}', stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now()
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_payment_intent_idx
        ON credit_transactions (stripe_payment_intent_id)`,
      `CREATE TABLE IF NOT EXISTS managed_domains (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        domain text NOT NULL UNIQUE, registrar text NOT NULL DEFAULT 'external',
        registered_at timestamp, expires_at timestamp,
        auto_renew boolean NOT NULL DEFAULT true, status text NOT NULL DEFAULT 'pending',
        registrant_info jsonb, resource_type text, app_id uuid, container_id uuid,
        agent_id uuid, mcp_id uuid, nameserver_mode text NOT NULL DEFAULT 'external',
        dns_records jsonb DEFAULT '[]', ssl_status text DEFAULT 'pending',
        ssl_expires_at timestamp, verified boolean NOT NULL DEFAULT false,
        verification_token text, verified_at timestamp,
        moderation_status text NOT NULL DEFAULT 'clean', moderation_flags jsonb DEFAULT '[]',
        last_health_check timestamp, is_live boolean NOT NULL DEFAULT false,
        health_check_error text, content_hash text, last_content_scan_at timestamp,
        last_ai_scan_at timestamp, ai_scan_model text, content_scan_confidence real,
        content_scan_cache jsonb, suspended_at timestamp, suspension_reason text,
        suspension_notification jsonb, owner_notified_at timestamp,
        cloudflare_zone_id text, cloudflare_registration_id text, purchase_price text,
        renewal_price text, payment_method text, stripe_payment_intent_id text,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      )`,
    ];
    for (const stmt of ddl) await dbWrite.execute(stmt);
  } catch (error) {
    pgliteReady = false;
    console.warn("[domain-maintenance] PGlite unavailable, skipping:", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("domain renewal billing (#10245)", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("20.000000");
  });

  test("due domain with funds → debited once, registrar renewed, expiry advanced", async () => {
    if (!pgliteReady) return;
    await seedDomain({ expiresInDays: 7, renewalPriceCents: 1099 });
    const before = await readDomain();

    const summary = await domainRenewalsService.processDomainRenewals();

    expect(summary.renewed).toBe(1);
    expect(await readBalance()).toBeCloseTo(20 - 10.99, 6);
    expect(await countRenewalDebits()).toBe(1);
    const after = await readDomain();
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(
      new Date(before.expires_at).getTime(),
    );
  });

  test("idempotent: a period already charged is NOT re-debited", async () => {
    if (!pgliteReady) return;
    await seedDomain({ expiresInDays: 7, renewalPriceCents: 1099 });
    const { expires_at } = await readDomain();
    // Simulate a prior successful charge for this exact period that never
    // advanced the expiry (e.g. recordRenewal failed mid-run).
    await dbWrite.execute(
      `INSERT INTO credit_transactions (id, organization_id, amount, type, metadata)
       VALUES (gen_random_uuid(), '${ORG}', '-10.99', 'debit',
         '${JSON.stringify({ type: "domain_renewal", domain: "renew-me.com", renewalPeriod: new Date(expires_at).toISOString() })}'::jsonb);`,
    );
    const balanceBefore = await readBalance();

    const summary = await domainRenewalsService.processDomainRenewals();

    expect(summary.alreadyCharged).toBe(1);
    expect(summary.renewed).toBe(0);
    // No second debit.
    expect(await readBalance()).toBeCloseTo(balanceBefore, 6);
  });

  test("declined debit (insufficient funds) → domain lapses (auto_renew disabled), no charge", async () => {
    if (!pgliteReady) return;
    await seedOrg("1.000000");
    await seedDomain({ expiresInDays: 7, renewalPriceCents: 1099 });

    const summary = await domainRenewalsService.processDomainRenewals();

    expect(summary.declined).toBe(1);
    expect(summary.renewed).toBe(0);
    expect(await readBalance()).toBeCloseTo(1, 6);
    expect((await readDomain()).auto_renew).toBe(false);
  });

  test("registrar failure after debit → refunded exactly once (net zero)", async () => {
    if (!pgliteReady) return;
    await seedDomain({ domain: "fail-renew-x.com", expiresInDays: 7, renewalPriceCents: 1099 });

    const summary = await domainRenewalsService.processDomainRenewals();

    expect(summary.failed).toBe(1);
    expect(summary.renewed).toBe(0);
    // Debit then refund → balance unchanged.
    expect(await readBalance()).toBeCloseTo(20, 6);
  });

  test("not due (expiry far in the future) → skipped", async () => {
    if (!pgliteReady) return;
    await seedDomain({ expiresInDays: 200 });

    const summary = await domainRenewalsService.processDomainRenewals();

    expect(summary.due).toBe(0);
    expect(await readBalance()).toBeCloseTo(20, 6);
  });
});

describe("custom-domain health probe (#10244)", () => {
  beforeEach(async () => {
    if (!pgliteReady) return;
    await seedOrg("20.000000");
    safeFetchMock.mockReset();
  });

  test("2xx /health → is_live true, no error", async () => {
    if (!pgliteReady) return;
    await seedDomain({ isLive: false });
    safeFetchMock.mockResolvedValue(new Response("ok", { status: 200 }));

    const summary = await domainHealthService.probeDomainHealth();

    expect(summary.checked).toBe(1);
    expect(summary.live).toBe(1);
    const after = await readDomain();
    expect(after.is_live).toBe(true);
    expect(after.health_check_error).toBeNull();
  });

  test("5xx /health → is_live false, error recorded", async () => {
    if (!pgliteReady) return;
    await seedDomain({ isLive: false });
    safeFetchMock.mockResolvedValue(new Response("down", { status: 503 }));

    const summary = await domainHealthService.probeDomainHealth();

    expect(summary.live).toBe(0);
    const after = await readDomain();
    expect(after.is_live).toBe(false);
    expect(after.health_check_error).toContain("503");
  });

  test("network error → is_live false, error recorded", async () => {
    if (!pgliteReady) return;
    await seedDomain({ isLive: false });
    safeFetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const summary = await domainHealthService.probeDomainHealth();

    expect(summary.live).toBe(0);
    const after = await readDomain();
    expect(after.is_live).toBe(false);
    expect(after.health_check_error).toContain("ECONNREFUSED");
  });

  test("already-live domains are not re-probed", async () => {
    if (!pgliteReady) return;
    await seedDomain({ isLive: true });

    const summary = await domainHealthService.probeDomainHealth();

    expect(summary.checked).toBe(0);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

// Loud guard: PGlite is in-process (no network), so `pgliteReady` must be true.
// If pushSchema/PGlite ever fails to init, the DB-dependent tests above
// early-return; this turns that silent no-op into a hard CI failure so a
// money-path proof can never masquerade as a vacuous green.
test("pglite schema applied — never a silent skip", () => {
  expect(pgliteReady).toBe(true);
});
