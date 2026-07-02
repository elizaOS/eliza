/**
 * Money-gated LIVE e2e: Cloud app creation + REAL domain purchase (#10691).
 *
 * Drives the full money path against a live cloud-api (staging or prod):
 *
 *   1. auth preflight     GET /credits/balance → 200, org funded ≥ the ceiling.
 *   2. create app         POST /apps (unique run-slugged name).
 *   3. deploy             POST /apps/:id/deploy (source build, EDAD dockerfile
 *                         by default) → poll deploy/status to READY → live URL.
 *   4. quote + CEILING    POST /apps/:id/domains/check on each cheap candidate
 *                         TLD (.xyz/.click/.sbs) with a unique base36 run slug;
 *                         the cheapest available quote must be ≤ the ceiling
 *                         (default 500¢) or the test FAILS BEFORE ANY BUY.
 *   5. buy                POST /apps/:id/domains/buy — real Cloudflare
 *                         registration + real credit debit. Balance delta must
 *                         equal the debited amount. Ledgered before and after.
 *   6. poll status        POST /apps/:id/domains/status until active+verified.
 *   7. serve              GET /apps-ingress/ask authorizes TLS for the domain,
 *                         then https://<domain> (or http:// while TLS issues)
 *                         answers within the cap.
 *   8. zero-cost negatives while owning the domain:
 *                         idempotent re-buy → 200 replay, NO second debit;
 *                         cross-tenant re-buy (second org key, when provided)
 *                         → 409, no charge.
 *   9. finally            detach the domain + delete the app; every outcome —
 *                         attempt/purchased/detached — appended to the JSONL
 *                         purchase ledger (registrations are non-refundable).
 *
 * MONEY GUARD — this suite runs ONLY when ALL of these are set:
 *   ELIZA_LIVE_DOMAIN_PURCHASE=1     explicit opt-in to spend real money
 *   ELIZA_LIVE_DOMAIN_BASE_URL       live cloud-api base (no default — pointing
 *                                    a paid run somewhere must be deliberate)
 *   CLOUD_E2E_API_KEY                funded operator org API key
 * Otherwise every test honest-skips at the describe level (before any fixture
 * resolves — the mock stack is never booted) and a console line states exactly
 * what to set. CI never sets these, so CI can never spend money here.
 *
 * The real-502-refund path (Cloudflare register fails AFTER the debit → refund)
 * is NOT deterministically reachable against live infra — we cannot inject a
 * registrar failure mid-flight on staging. It is exercised deterministically
 * against the registrar dev stub in `domain-purchase-harness.spec.ts` (the
 * `fail-` prefix) and stays documented as live-unreachable in
 * docs/domain-purchase-live.md rather than being faked here.
 *
 * Operator command + full env matrix: docs/domain-purchase-live.md.
 */

import {
  appendDomainLedger,
  assertPriceCeiling,
  buyDomain,
  createApp,
  DEFAULT_LEDGER_PATH,
  DEFAULT_MAX_PRICE_CENTS,
  deleteApp,
  deployAppToReady,
  detachDomain,
  getBalanceUsd,
  newRunId,
  pollDomainActive,
  probeUrlServes,
  quoteCheapestAvailableDomain,
} from "../src/helpers/domain-purchase";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

// ── money guard ─────────────────────────────────────────────────────────────

const LIVE_ENABLED = process.env.ELIZA_LIVE_DOMAIN_PURCHASE === "1";
const BASE_URL = process.env.ELIZA_LIVE_DOMAIN_BASE_URL?.replace(/\/+$/, "");
const API_KEY = process.env.CLOUD_E2E_API_KEY;
const GATE_SATISFIED = LIVE_ENABLED && Boolean(BASE_URL) && Boolean(API_KEY);

const SKIP_REASON =
  "live domain purchase (REAL MONEY) is off: set ELIZA_LIVE_DOMAIN_PURCHASE=1 " +
  "+ ELIZA_LIVE_DOMAIN_BASE_URL=<staging/prod cloud-api base> " +
  "+ CLOUD_E2E_API_KEY=<funded operator org key> to run it " +
  "(see packages/test/cloud-e2e/docs/domain-purchase-live.md)";

if (!GATE_SATISFIED) {
  const missing = [
    ...(LIVE_ENABLED ? [] : ["ELIZA_LIVE_DOMAIN_PURCHASE=1"]),
    ...(BASE_URL ? [] : ["ELIZA_LIVE_DOMAIN_BASE_URL"]),
    ...(API_KEY ? [] : ["CLOUD_E2E_API_KEY"]),
  ];
  // Loud, honest skip — a reader of the run output sees exactly what to set.
  console.log(
    `[domain-purchase.real] SKIP (no money spent): missing ${missing.join(", ")}. ${SKIP_REASON}`,
  );
}

// ── knobs (all optional; defaults documented in docs/domain-purchase-live.md) ─

const MAX_PRICE_CENTS = Number(
  process.env.ELIZA_LIVE_DOMAIN_MAX_PRICE_CENTS ?? DEFAULT_MAX_PRICE_CENTS,
);
const CANDIDATE_TLDS = (process.env.ELIZA_LIVE_DOMAIN_TLDS ?? "xyz,click,sbs")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
const LEDGER_PATH = process.env.ELIZA_DOMAIN_LEDGER_PATH ?? DEFAULT_LEDGER_PATH;
/** Second org key (deliberately UNFUNDED) → enables the 402 + cross-tenant 409 cases. */
const UNFUNDED_API_KEY = process.env.ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY;

const DEPLOY_CAP_MS = Number(
  process.env.ELIZA_LIVE_DOMAIN_DEPLOY_CAP_MS ?? 10 * 60_000,
);
const STATUS_CAP_MS = Number(
  process.env.ELIZA_LIVE_DOMAIN_STATUS_CAP_MS ?? 10 * 60_000,
);
const SERVE_CAP_MS = Number(
  process.env.ELIZA_LIVE_DOMAIN_SERVE_CAP_MS ?? 10 * 60_000,
);
const POLL_INTERVAL_MS = 5_000;

/** Live deploy build hints — same source-build shape the EDAD live driver uses. */
const DEPLOY_BODY = {
  repoUrl:
    process.env.ELIZA_LIVE_DOMAIN_DEPLOY_REPO_URL ??
    "https://github.com/elizaOS/eliza.git",
  ref: process.env.ELIZA_LIVE_DOMAIN_DEPLOY_REF ?? "develop",
  dockerfile:
    process.env.ELIZA_LIVE_DOMAIN_DEPLOY_DOCKERFILE ??
    "packages/examples/cloud/edad/Dockerfile.cloud",
};

test.describe("live domain purchase — real money, operator-gated (#10691)", () => {
  // Honest-skip gate FIRST — evaluated before any fixture resolves, so the mock
  // stack is never booted and no network call is made when the gate is closed.
  test.skip(!GATE_SATISFIED, SKIP_REASON);

  test("create app → deploy → buy real domain under ceiling → active → serves → detach", async () => {
    test.setTimeout(DEPLOY_CAP_MS + STATUS_CAP_MS + SERVE_CAP_MS + 180_000);
    const api = BASE_URL as string;
    const authed = authedClient(api, API_KEY as string);
    const runId = newRunId();
    const slug = `e2e-10691-${runId}`;

    // ── 1. auth preflight: key works and the org can afford the ceiling. ────
    const balanceBefore = await getBalanceUsd(authed);
    expect(
      balanceBefore,
      `org balance ($${balanceBefore}) must cover the ${MAX_PRICE_CENTS}¢ ceiling`,
    ).toBeGreaterThanOrEqual(MAX_PRICE_CENTS / 100);

    let appId: string | undefined;
    let purchasedDomain: string | undefined;
    let secondOrgAppId: string | undefined;
    try {
      // ── 2. create the app. ─────────────────────────────────────────────────
      appId = await createApp(authed, `Domain Purchase ${runId}`);
      console.log(`[domain-purchase.real] run ${runId}: app ${appId} @ ${api}`);

      // ── 3. deploy to a live URL (real source build on the apps worker). ───
      const productionUrl = await deployAppToReady(authed, appId, {
        body: DEPLOY_BODY,
        pollIntervalMs: POLL_INTERVAL_MS,
        capMs: DEPLOY_CAP_MS,
      });
      const liveApp = await fetch(productionUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      expect(
        liveApp.status,
        `deployed production_url ${productionUrl} serves before the domain step`,
      ).toBe(200);

      // ── 4. quote every candidate TLD; enforce the ceiling BEFORE buying. ──
      const candidate = await quoteCheapestAvailableDomain(
        authed,
        appId,
        slug,
        CANDIDATE_TLDS,
      );
      console.log(
        `[domain-purchase.real] quotes: ${candidate.allQuotes
          .map(
            (q) =>
              `${q.domain}=${q.available ? `${q.totalUsdCents}¢` : "unavailable"}`,
          )
          .join(
            ", ",
          )} → buying ${candidate.domain} (${candidate.totalUsdCents}¢, ceiling ${MAX_PRICE_CENTS}¢)`,
      );
      // Throws PriceCeilingExceededError (test fails) before any debit request.
      assertPriceCeiling(candidate, MAX_PRICE_CENTS);

      // ── 5. buy — ledgered on both sides of the real charge. ───────────────
      appendDomainLedger(LEDGER_PATH, {
        runId,
        timestamp: new Date().toISOString(),
        mode: "live",
        phase: "attempt",
        baseUrl: api,
        domain: candidate.domain,
        appId,
        quotedTotalUsdCents: candidate.totalUsdCents,
        priceCeilingCents: MAX_PRICE_CENTS,
      });
      const buy = await buyDomain(authed, appId, candidate.domain);
      if (buy.status !== 200 || buy.json.success !== true) {
        appendDomainLedger(LEDGER_PATH, {
          runId,
          timestamp: new Date().toISOString(),
          mode: "live",
          phase: "buy-failed",
          baseUrl: api,
          domain: candidate.domain,
          appId,
          quotedTotalUsdCents: candidate.totalUsdCents,
          httpStatus: buy.status,
          error: buy.json.error ?? JSON.stringify(buy.json),
        });
      }
      expect(buy.status, `buy response: ${JSON.stringify(buy.json)}`).toBe(200);
      expect(buy.json.success, "domain buy succeeds").toBe(true);
      purchasedDomain = candidate.domain;

      const debitedCents = buy.json.debited?.totalUsdCents;
      expect(
        typeof debitedCents === "number",
        "buy reports the debited amount",
      ).toBe(true);
      expect(
        debitedCents as number,
        "the actual debit respects the ceiling",
      ).toBeLessThanOrEqual(MAX_PRICE_CENTS);

      appendDomainLedger(LEDGER_PATH, {
        runId,
        timestamp: new Date().toISOString(),
        mode: "live",
        phase: "purchased",
        baseUrl: api,
        domain: candidate.domain,
        appId,
        quotedTotalUsdCents: candidate.totalUsdCents,
        debitedTotalUsdCents: debitedCents,
        zoneId: buy.json.zoneId ?? null,
        appDomainId: buy.json.appDomainId ?? null,
        // Not exposed by any cloud-api response today — see the API-gap note
        // in docs/domain-purchase-live.md.
        cloudflareRegistrationId: null,
        expiresAt: buy.json.expiresAt ?? null,
        httpStatus: buy.status,
      });

      const balanceAfterBuy = await getBalanceUsd(authed);
      const deltaUsd = balanceBefore - balanceAfterBuy;
      console.log(
        `[domain-purchase.real] debited $${deltaUsd.toFixed(4)} (reported ${debitedCents}¢) for ${candidate.domain}`,
      );
      expect(
        Math.abs(deltaUsd - (debitedCents as number) / 100),
        "balance delta equals the reported debit",
      ).toBeLessThan(0.01);

      // ── 6. registration reaches active + verified. ─────────────────────────
      const status = await pollDomainActive(authed, appId, candidate.domain, {
        pollIntervalMs: POLL_INTERVAL_MS,
        capMs: STATUS_CAP_MS,
      });
      expect(status.registrar, "bought domain is cloudflare-managed").toBe(
        "cloudflare",
      );

      // ── 7a. ingress authorizes on-demand TLS for the custom domain. ───────
      const ask = await fetch(
        `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(candidate.domain)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      expect(
        ask.status,
        "apps-ingress/ask authorizes a TLS cert for the purchased domain",
      ).toBe(200);

      // ── 7b. the domain actually serves over public DNS. ───────────────────
      const probe = await probeUrlServes(
        [`https://${candidate.domain}`, `http://${candidate.domain}`],
        { pollIntervalMs: POLL_INTERVAL_MS, capMs: SERVE_CAP_MS },
      );
      expect(
        probe.ok,
        `purchased domain serves within ${SERVE_CAP_MS}ms — ` +
          `${probe.attempts} attempts, last error: ${probe.lastError ?? "none"} ` +
          "(registration + charge DID complete and are ledgered; " +
          "staging must set ELIZA_CUSTOM_DOMAIN_ORIGIN_IP/HOST for automatic DNS — " +
          "see docs/domain-purchase-live.md)",
      ).toBe(true);
      console.log(
        `[domain-purchase.real] ${probe.url} → HTTP ${probe.httpStatus} after ${probe.attempts} attempts`,
      );

      // ── 8a. idempotent re-buy replays the completed purchase — NO 2nd debit.
      const rebuy = await buyDomain(authed, appId, candidate.domain);
      expect(
        rebuy.status,
        `idempotent re-buy replays (got ${rebuy.status}: ${JSON.stringify(rebuy.json)})`,
      ).toBe(200);
      expect(rebuy.json.success).toBe(true);
      const balanceAfterRebuy = await getBalanceUsd(authed);
      expect(
        Math.abs(balanceAfterRebuy - balanceAfterBuy),
        "re-buy does not charge again",
      ).toBeLessThan(0.005);

      // ── 8b. cross-tenant buy of an owned domain → 409, no charge. ─────────
      if (UNFUNDED_API_KEY) {
        const other = authedClient(api, UNFUNDED_API_KEY);
        secondOrgAppId = await createApp(other, `Cross Tenant ${runId}`);
        const otherBalanceBefore = await getBalanceUsd(other);
        const crossBuy = await buyDomain(
          other,
          secondOrgAppId,
          candidate.domain,
        );
        expect(
          crossBuy.status,
          `cross-tenant buy of an owned domain is rejected (${JSON.stringify(crossBuy.json)})`,
        ).toBe(409);
        const otherBalanceAfter = await getBalanceUsd(other);
        expect(
          Math.abs(otherBalanceAfter - otherBalanceBefore),
          "cross-tenant 409 never charges",
        ).toBeLessThan(0.005);
      } else {
        console.log(
          "[domain-purchase.real] cross-tenant 409 case skipped: set " +
            "ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY=<second unfunded org key> to run it",
        );
      }
    } finally {
      // ── 9. cleanup — detach + delete; the registration itself persists
      // (Cloudflare registrations are non-refundable) and stays ledgered.
      if (appId && purchasedDomain) {
        const detachStatus = await detachDomain(authed, appId, purchasedDomain);
        appendDomainLedger(LEDGER_PATH, {
          runId,
          timestamp: new Date().toISOString(),
          mode: "live",
          phase: detachStatus === 200 ? "detached" : "detach-failed",
          baseUrl: api,
          domain: purchasedDomain,
          appId,
          detachStatus,
        });
        console.log(
          `[domain-purchase.real] detach ${purchasedDomain} → HTTP ${detachStatus} (ledger: ${LEDGER_PATH})`,
        );
      }
      if (secondOrgAppId && UNFUNDED_API_KEY) {
        await deleteApp(authedClient(api, UNFUNDED_API_KEY), secondOrgAppId);
      }
      if (appId) {
        const deleted = await deleteApp(authed, appId);
        console.log(
          `[domain-purchase.real] app ${appId} delete → HTTP ${deleted}`,
        );
      }
    }
  });

  test("buying an unavailable domain → 409 and never charges", async () => {
    test.setTimeout(120_000);
    const api = BASE_URL as string;
    const authed = authedClient(api, API_KEY as string);
    // example.com is IANA-reserved — permanently registered, never buyable.
    const takenDomain = "example.com";

    const balanceBefore = await getBalanceUsd(authed);
    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Domain 409 ${newRunId()}`);

      const check = await authed<{ success?: boolean; available?: boolean }>(
        "POST",
        `/api/v1/apps/${appId}/domains/check`,
        { domain: takenDomain },
      );
      expect(check.status).toBe(200);
      expect(
        check.json.available,
        `${takenDomain} reports unavailable on the live registrar`,
      ).toBe(false);

      const buy = await buyDomain(authed, appId, takenDomain);
      expect(
        buy.status,
        `unavailable buy is rejected (${JSON.stringify(buy.json)})`,
      ).toBe(409);

      const balanceAfter = await getBalanceUsd(authed);
      expect(
        Math.abs(balanceAfter - balanceBefore),
        "409 rejection never debits",
      ).toBeLessThan(0.005);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });

  test("insufficient credits → 402, fail-closed before any registration", async () => {
    // Needs a deliberately UNFUNDED second org: staging offers no deterministic
    // credit-drain endpoint (deductCredits is service-internal, not a route),
    // so an operator provisions a zero-balance org key once and reuses it.
    // The same seam is covered deterministically against the mock stack in
    // domain-purchase-harness.spec.ts via a zero-balance seeded org.
    test.skip(
      !UNFUNDED_API_KEY,
      "402 case: set ELIZA_LIVE_DOMAIN_UNFUNDED_API_KEY=<zero-balance org key> " +
        "(no deterministic credit-drain API exists against staging)",
    );
    test.setTimeout(120_000);
    const api = BASE_URL as string;
    const authed = authedClient(api, UNFUNDED_API_KEY as string);
    const runId = newRunId();
    const slug = `e2e-10691-poor-${runId}`;

    let appId: string | undefined;
    try {
      appId = await createApp(authed, `Domain 402 ${runId}`);

      const candidate = await quoteCheapestAvailableDomain(
        authed,
        appId,
        slug,
        CANDIDATE_TLDS,
      );
      const balanceBefore = await getBalanceUsd(authed);
      expect(
        balanceBefore,
        "the 402 fixture org must hold less than the cheapest quote " +
          `($${candidate.totalUsdCents / 100}) — re-provision the unfunded key`,
      ).toBeLessThan(candidate.totalUsdCents / 100);

      const buy = await buyDomain(authed, appId, candidate.domain);
      expect(
        buy.status,
        `insufficient-credit buy → 402 (${JSON.stringify(buy.json)})`,
      ).toBe(402);

      const balanceAfter = await getBalanceUsd(authed);
      expect(
        Math.abs(balanceAfter - balanceBefore),
        "402 never debits",
      ).toBeLessThan(0.005);

      // Fail-closed proof: the decline happened BEFORE any registrar call, so
      // the domain must still be available (it was never registered to us).
      const recheck = await authed<{ available?: boolean }>(
        "POST",
        `/api/v1/apps/${appId}/domains/check`,
        { domain: candidate.domain },
      );
      expect(recheck.status).toBe(200);
      expect(
        recheck.json.available,
        "declined domain was never registered (fail closed)",
      ).toBe(true);
    } finally {
      if (appId) await deleteApp(authed, appId);
    }
  });
});
