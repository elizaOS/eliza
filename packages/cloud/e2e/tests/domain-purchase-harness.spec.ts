/**
 * Harness-logic verification for the money-gated domain-purchase lane (#10691).
 *
 * Runs the SAME helpers as `domain-purchase.real.spec.ts` — chain steps, price
 * ceiling, purchase ledger, negative paths — against the booted mock stack
 * (Cloudflare registrar dev stub, ELIZA_CF_REGISTRAR_DEV_STUB=1). This is
 * HARNESS-LOGIC VERIFICATION, NOT money-path evidence: no real registrar call,
 * no real charge. It exists so the paid lane's logic is continuously proven in
 * CI and cannot rot between (rare, operator-gated) paid runs.
 *
 * Stub semantics used here (cloud-shared cloudflare-registrar.ts):
 *   - every domain quotes 1099¢ wholesale (margin added by the routes),
 *     registers instantly, status "active"
 *   - `taken-` prefix  → unavailable          → the 409 path
 *   - `fail-`  prefix  → register throws      → the debit→refund→502 path
 *     (the one negative that is NOT deterministically reachable live)
 *
 * The mock ledger is written to the per-test Playwright output dir — the
 * durable `domain-purchase-ledger/ledger.jsonl` records real spend only.
 */

import { readFileSync } from "node:fs";
import { seedTestUser } from "../src/fixtures/seed";
import {
  appendDomainLedger,
  assertPriceCeiling,
  buyDomain,
  createApp,
  type DomainLedgerEntry,
  deleteApp,
  deployAppToReady,
  detachDomain,
  getBalanceUsd,
  newRunId,
  PriceCeilingExceededError,
  pollDomainActive,
  probeUrlServes,
  quoteCheapestAvailableDomain,
} from "../src/helpers/domain-purchase";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({ stackOptions: { frontend: false } });

/**
 * The registrar fixture quotes every domain at 1099¢ wholesale; the check/buy
 * routes add the platform margin via computeDomainPrice (1495¢ total here —
 * the same $14.95 the domain-lifecycle spec asserts). Assert against the
 * quoted TOTAL rather than hardcoding the margin math.
 */
const STUB_WHOLESALE_CENTS = 1099;
/** Ceiling that admits the fixture total for the happy chain. */
const PERMISSIVE_CEILING_CENTS = 2000;
/** Production default ceiling (500¢) that must refuse the fixture quote. */
const STRICT_CEILING_CENTS = 500;

const MOCK_POLL = { pollIntervalMs: 250, capMs: 30_000 };

test.describe("domain purchase harness logic (mock registrar stub)", () => {
  test("full chain: create → deploy → quote+ceiling → buy → active → serves → re-buy replay → detach, all ledgered", async ({
    stack,
    seededUser,
  }, testInfo) => {
    const api = stack.urls.api;
    const authed = authedClient(api, seededUser.apiKey);
    const runId = newRunId();
    const slug = `harness-${runId}`;
    const ledgerPath = testInfo.outputPath("domain-ledger.jsonl");

    const balanceBefore = await getBalanceUsd(authed);

    let appId: string | undefined;
    let purchasedDomain: string | undefined;
    try {
      appId = await createApp(authed, `Harness Chain ${runId}`);

      // Deploy via the mock apps worker (DB-backed jobs pumped by the tick).
      const productionUrl = await deployAppToReady(authed, appId, {
        tick: async () => {
          const processed = await stack.mocks.controlPlane.processDbBackedJobs(
            stack.urls.pglite,
          );
          expect(processed.failed, JSON.stringify(processed.errors)).toBe(0);
        },
        ...MOCK_POLL,
      });

      // Quote all candidate TLDs through the real check route (stub-priced).
      const candidate = await quoteCheapestAvailableDomain(
        authed,
        appId,
        slug,
        ["xyz", "click", "sbs"],
      );
      // Total = stub wholesale + platform margin; every TLD quotes identically.
      expect(candidate.totalUsdCents).toBeGreaterThanOrEqual(
        STUB_WHOLESALE_CENTS,
      );
      expect(candidate.allQuotes).toHaveLength(3);
      for (const quote of candidate.allQuotes) {
        expect(quote.totalUsdCents).toBe(candidate.totalUsdCents);
      }
      assertPriceCeiling(candidate, PERMISSIVE_CEILING_CENTS);

      appendDomainLedger(ledgerPath, {
        runId,
        timestamp: new Date().toISOString(),
        mode: "mock-stub",
        phase: "attempt",
        baseUrl: api,
        domain: candidate.domain,
        appId,
        quotedTotalUsdCents: candidate.totalUsdCents,
        priceCeilingCents: PERMISSIVE_CEILING_CENTS,
      });

      const buy = await buyDomain(authed, appId, candidate.domain);
      expect(buy.status, JSON.stringify(buy.json)).toBe(200);
      expect(buy.json.success).toBe(true);
      // The debit must equal the pre-buy quote (same computeDomainPrice path).
      expect(buy.json.debited?.totalUsdCents).toBe(candidate.totalUsdCents);
      purchasedDomain = candidate.domain;

      appendDomainLedger(ledgerPath, {
        runId,
        timestamp: new Date().toISOString(),
        mode: "mock-stub",
        phase: "purchased",
        baseUrl: api,
        domain: candidate.domain,
        appId,
        quotedTotalUsdCents: candidate.totalUsdCents,
        debitedTotalUsdCents: buy.json.debited?.totalUsdCents,
        zoneId: buy.json.zoneId ?? null,
        appDomainId: buy.json.appDomainId ?? null,
        cloudflareRegistrationId: null,
        expiresAt: buy.json.expiresAt ?? null,
        httpStatus: buy.status,
      });

      // Exact debit lands on the balance.
      const balanceAfterBuy = await getBalanceUsd(authed);
      expect(
        Math.abs(
          balanceBefore - balanceAfterBuy - candidate.totalUsdCents / 100,
        ),
        "balance debited by exactly the quoted total",
      ).toBeLessThan(0.005);

      // Registration reaches active + verified through the real status route.
      const status = await pollDomainActive(authed, appId, candidate.domain, {
        pollIntervalMs: 250,
        capMs: 10_000,
      });
      expect(status.registrar).toBe("cloudflare");

      // Public DNS for a stub purchase cannot resolve — the live lane probes
      // https://<domain>. Here we prove the serve-probe helper against the app's
      // real (mock-container) production URL instead. Harness-logic only.
      const probe = await probeUrlServes([productionUrl], MOCK_POLL);
      expect(probe.ok, probe.lastError ?? "").toBe(true);
      expect(probe.httpStatus).toBe(200);

      // Idempotent re-buy replays the completed purchase — no second debit.
      const rebuy = await buyDomain(authed, appId, candidate.domain);
      expect(rebuy.status, JSON.stringify(rebuy.json)).toBe(200);
      expect(rebuy.json.success).toBe(true);
      const balanceAfterRebuy = await getBalanceUsd(authed);
      expect(
        Math.abs(balanceAfterRebuy - balanceAfterBuy),
        "idempotent re-buy never double-charges",
      ).toBeLessThan(0.005);
    } finally {
      if (appId && purchasedDomain) {
        const detachStatus = await detachDomain(authed, appId, purchasedDomain);
        appendDomainLedger(ledgerPath, {
          runId,
          timestamp: new Date().toISOString(),
          mode: "mock-stub",
          phase: detachStatus === 200 ? "detached" : "detach-failed",
          baseUrl: api,
          domain: purchasedDomain,
          appId,
          detachStatus,
        });
        expect(detachStatus, "detach succeeds in the finally block").toBe(200);
      }
      if (appId) await deleteApp(authed, appId);
    }

    // The ledger is well-formed JSONL with the full attempt→purchased→detached
    // lifecycle — the exact record a paid run leaves behind.
    const entries = readFileSync(ledgerPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DomainLedgerEntry);
    expect(entries.map((e) => e.phase)).toEqual([
      "attempt",
      "purchased",
      "detached",
    ]);
    for (const entry of entries) {
      expect(entry.runId).toBe(runId);
      expect(entry.mode).toBe("mock-stub");
      expect(entry.domain).toBe(purchasedDomain);
      expect(Date.parse(entry.timestamp)).not.toBeNaN();
    }
    expect(entries[1].debitedTotalUsdCents).toBe(
      entries[0].quotedTotalUsdCents,
    );
    expect(entries[1].debitedTotalUsdCents ?? 0).toBeGreaterThanOrEqual(
      STUB_WHOLESALE_CENTS,
    );
    expect(entries[2].detachStatus).toBe(200);
  });

  test("price ceiling refuses to buy BEFORE any debit", async ({
    stack,
    seededUser,
  }) => {
    const authed = authedClient(stack.urls.api, seededUser.apiKey);
    const balanceBefore = await getBalanceUsd(authed);

    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Harness Ceiling ${newRunId()}`);
      const candidate = await quoteCheapestAvailableDomain(
        authed,
        appId,
        `ceiling-${newRunId()}`,
        ["xyz"],
      );
      expect(candidate.totalUsdCents).toBeGreaterThan(STRICT_CEILING_CENTS);
      expect(() => assertPriceCeiling(candidate, STRICT_CEILING_CENTS)).toThrow(
        PriceCeilingExceededError,
      );
      // Nothing was bought and nothing was charged.
      const balanceAfter = await getBalanceUsd(authed);
      expect(Math.abs(balanceAfter - balanceBefore)).toBeLessThan(0.005);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });

  test("unavailable domain → 409, no charge", async ({ stack, seededUser }) => {
    const authed = authedClient(stack.urls.api, seededUser.apiKey);
    const balanceBefore = await getBalanceUsd(authed);

    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Harness 409 ${newRunId()}`);
      // The stub treats `taken-` domains as unavailable.
      const domain = `taken-${newRunId()}.xyz`;

      const check = await authed<{ available?: boolean }>(
        "POST",
        `/api/v1/apps/${appId}/domains/check`,
        { domain },
      );
      expect(check.status).toBe(200);
      expect(check.json.available).toBe(false);

      const buy = await buyDomain(authed, appId, domain);
      expect(buy.status, JSON.stringify(buy.json)).toBe(409);

      const balanceAfter = await getBalanceUsd(authed);
      expect(Math.abs(balanceAfter - balanceBefore)).toBeLessThan(0.005);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });

  test("registrar failure after debit → 502 with full refund", async ({
    stack,
    seededUser,
  }) => {
    // This is the negative the LIVE lane cannot reach deterministically (no way
    // to inject a Cloudflare failure mid-purchase on staging) — the stub's
    // `fail-` prefix throws from registerDomain AFTER the debit, driving the
    // real refund seam in the buy route.
    const authed = authedClient(stack.urls.api, seededUser.apiKey);
    const balanceBefore = await getBalanceUsd(authed);

    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Harness 502 ${newRunId()}`);
      const buy = await buyDomain(authed, appId, `fail-${newRunId()}.xyz`);
      expect(buy.status, JSON.stringify(buy.json)).toBe(502);
      expect(buy.json.success).toBe(false);

      const balanceAfter = await getBalanceUsd(authed);
      expect(
        Math.abs(balanceAfter - balanceBefore),
        "debit is fully refunded on registrar failure",
      ).toBeLessThan(0.005);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });

  test("insufficient credits → 402, fail-closed before registration", async ({
    stack,
  }) => {
    // A deliberately broke org — the mock-lane analogue of the live lane's
    // operator-provisioned ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY.
    const broke = await seedTestUser({ creditBalance: "0.000000" });
    const authed = authedClient(stack.urls.api, broke.apiKey);

    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Harness 402 ${newRunId()}`);
      const domain = `poor-${newRunId()}.xyz`;

      const buy = await buyDomain(authed, appId, domain);
      expect(buy.status, JSON.stringify(buy.json)).toBe(402);
      expect(buy.json.code).toBe("insufficient_balance");

      const balanceAfter = await getBalanceUsd(authed);
      expect(balanceAfter, "broke org stays at zero").toBeLessThan(0.005);

      // Fail-closed: the decline happened BEFORE any registrar call, so the
      // domain was never registered and is still available.
      const recheck = await authed<{ available?: boolean }>(
        "POST",
        `/api/v1/apps/${appId}/domains/check`,
        { domain },
      );
      expect(recheck.status).toBe(200);
      expect(recheck.json.available).toBe(true);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });

  test("cross-tenant buy of an owned domain → 409, no charge", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const owner = authedClient(api, seededUser.apiKey);
    const runId = newRunId();
    const domain = `tenant-${runId}.xyz`;

    let ownerAppId: string | undefined;
    let attackerAppId: string | undefined;
    try {
      ownerAppId = await createApp(owner, `Harness Owner ${runId}`);
      const buy = await buyDomain(owner, ownerAppId, domain);
      expect(buy.status, JSON.stringify(buy.json)).toBe(200);

      const attacker = await seedTestUser();
      const other = authedClient(api, attacker.apiKey);
      attackerAppId = await createApp(other, `Harness Attacker ${runId}`);

      const otherBalanceBefore = await getBalanceUsd(other);
      const crossBuy = await buyDomain(other, attackerAppId, domain);
      expect(crossBuy.status, JSON.stringify(crossBuy.json)).toBe(409);
      const otherBalanceAfter = await getBalanceUsd(other);
      expect(
        Math.abs(otherBalanceAfter - otherBalanceBefore),
        "cross-tenant 409 never charges",
      ).toBeLessThan(0.005);

      if (attackerAppId) {
        await deleteApp(other, attackerAppId);
        attackerAppId = undefined;
      }
    } finally {
      if (ownerAppId) {
        await detachDomain(owner, ownerAppId, domain);
        await deleteApp(owner, ownerAppId);
      }
    }
  });
});
