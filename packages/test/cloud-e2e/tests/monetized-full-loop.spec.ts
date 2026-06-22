/**
 * Monetized full-loop e2e (cloud:mock) — issue #8935.
 *
 * Extends the ~70% baseline in `monetized-app-loop.spec.ts` (which stops at
 * create → monetize → buy-domain → earn → survive) into the full autonomous
 * lifecycle with an explicit, observable state-transition assertion at every
 * step:
 *
 *   a. seed org with credits
 *   b. apps.create                 → app row created
 *   c. DEPLOY / provision a node    → control-plane provision job drives the
 *                                     Hetzner mock server initializing → running
 *   d. domains.check + domains.buy  → exact $14.95 debit + verified (CF stub)
 *   e. apps.monetization.update     → monetization enabled (read-back)
 *   f. charge                       → org credit debit + creator earnings ledger
 *   g. AUTOSCALE                    → node-autoscale cron tick + Hetzner-mock
 *                                     pool replenished (a second node stood up)
 *   h. PAYOUT                       → redeemable balance is the payout-readiness
 *                                     proxy; the fiat transfer is skipped (#8922)
 *
 * Why this drives provisioning through the control-plane STORE + tick() rather
 * than the cloud-api deploy route: the mock stack's DB-backed AGENT_PROVISION
 * handler stands a sandbox up in-memory and never touches the Hetzner mock, so
 * it cannot prove a real server `initializing → running`. The in-memory
 * `tick()` path (`processProvisionJob`) is the one that actually POSTs to the
 * Hetzner mock and polls the create action to success — so it is the only seam
 * in this stack that produces an observable Hetzner node transition + a
 * replenished pool. The real provisioning-worker `--with-daemon` autoscale path
 * is deferred to #8920 / #8921 (see docs/monetized-loop-coverage.md); the
 * REAL-Hetzner variant of this loop runs nightly via
 * `.github/workflows/monetized-loop-nightly.yml`.
 *
 * Load-bearing invariants (exact, not smoke):
 *   - Hetzner node: server count grows by 1 per provision, each reaching
 *     `running` (initializing → running) within the action window.
 *   - domain debit: 1099¢ wholesale + ceil(1099*3600/10000)=396¢ margin =
 *     1495¢ → org balance 1000 - 14.95 = 985.05 (tolerance < $0.01).
 *   - charge: a $0.50 org debit lands AND a matching $0.50 creator earnings
 *     ledger entry is recorded (creator redeemable balance rises by exactly
 *     0.50).
 *   - autoscale: node-autoscale cron tick counter increments AND a fresh
 *     provision replenishes the Hetzner pool by one more `running` node.
 *
 * Uses the `stack` + `seededUser` fixtures (same as the baseline) so we hit
 * `stack.urls.api` and the seed fixture guarantees DATABASE_URL points at the
 * running PGlite bridge before the direct cloud-shared service calls run.
 */

import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import type { MockServer } from "@elizaos/cloud-test-mocks/hetzner";
import { authedClient } from "../src/helpers/monetization";
import { expect, test } from "../src/helpers/test-fixtures";

/** apps.create returns { success, app: <App>, apiKey, ... }; we only read id. */
interface CreateAppResponse {
  success?: boolean;
  app?: { id?: string };
}

/** domains.buy success envelope (see cloud-api .../domains/buy/route.ts). */
interface DomainBuyResponse {
  success?: boolean;
  verified?: boolean;
  debited?: { totalUsdCents?: number; currency?: string };
}

/** apps.monetization GET read-back (see cloud-api .../monetization/route.ts). */
interface AppMonetizationResponse {
  success?: boolean;
  monetization?: { monetizationEnabled?: boolean };
}

/** The exact charge applied in step (f), in USD. */
const CHARGE_USD = 0.5;

test.describe("monetized full loop", () => {
  test("seed → create → deploy → domain → monetize → charge → autoscale → payout-ready", async ({
    stack,
    seededUser,
  }) => {
    const api = stack.urls.api;
    const authed = authedClient(api, seededUser.apiKey);
    const hetznerStore = stack.mocks.hetzner.store;
    const controlPlane = stack.mocks.controlPlane;

    const runningCount = (): number =>
      [...hetznerStore.servers.values()].filter(
        (s: MockServer) => s.status === "running",
      ).length;

    // 0. Fail legibly if the stack isn't up before any loop step runs.
    const health = await fetch(`${api}/api/health`);
    expect(health.status, "stack /api/health must be reachable").toBe(200);

    // ── a. Seed org: the seed fixture funds the org with 1000 credits. ──────
    const startBalance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(startBalance.status).toBe(200);
    expect(startBalance.json.balance).toBeCloseTo(1000, 2);

    // ── b. Create the app. ─────────────────────────────────────────────────
    const created = await authed<CreateAppResponse>("POST", "/api/v1/apps", {
      name: `Full Loop App ${Date.now().toString(36)}`,
      app_url: "https://placeholder.invalid",
      skipGitHubRepo: true,
    });
    expect([200, 201]).toContain(created.status);
    const appId = created.json.app?.id;
    expect(appId, "apps.create must return an app id").toBeTruthy();
    if (!appId) throw new Error("apps.create did not return an app id");

    // ── c. Deploy / provision a node. ──────────────────────────────────────
    // Drive a provision job through the control-plane store + tick() so the
    // Hetzner mock actually stands a server up. The server is born
    // `initializing` and the create action flips it to `running` after the
    // action window — the observable deploy → running transition.
    const serversBeforeDeploy = runningCount();
    const deploySandbox = controlPlane.store.createSandbox({
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
      agentId: appId,
    });
    controlPlane.store.createJob({
      type: "agent_provision",
      sandboxId: deploySandbox.id,
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
      payload: { agentName: "full-loop-deploy" },
    });

    // First tick POSTs to the Hetzner mock; the new server starts initializing
    // and the create action resolves to running inside processProvisionJob's
    // pollHetznerAction loop. tick() returns only after the action settles.
    const deployTick = await controlPlane.tick();
    expect(
      deployTick.failed,
      "provision tick must not fail the deploy job",
    ).toBe(0);
    expect(
      deployTick.processed,
      "exactly one provision job processed",
    ).toBe(1);

    // The sandbox is running and a fresh Hetzner node reached `running`.
    expect(controlPlane.store.getSandbox(deploySandbox.id)?.status).toBe(
      "running",
    );
    expect(
      runningCount(),
      "deploy stood up exactly one running Hetzner node",
    ).toBe(serversBeforeDeploy + 1);

    // ── d. Buy a custom domain (Cloudflare registrar stub) — real debit. ────
    const domain = `loop-${Date.now().toString(36)}.com`;
    const check = await authed("POST", `/api/v1/apps/${appId}/domains/check`, {
      domain,
    });
    expect([200, 201]).toContain(check.status);

    const buy = await authed<DomainBuyResponse>(
      "POST",
      `/api/v1/apps/${appId}/domains/buy`,
      { domain },
    );
    expect([200, 201]).toContain(buy.status);
    expect(buy.json.success, "domain buy must succeed").toBe(true);
    expect(buy.json.verified, "domain must be registered + attached").toBe(true);

    // Exact domain-markup math: $10.99 wholesale + $3.96 margin = $14.95 off
    // the 1000-credit balance → 985.05 (< $0.01 tolerance). Mirrors the
    // baseline spec so a registrar-pricing regression fails both.
    const afterBuy = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(afterBuy.status).toBe(200);
    expect(
      Math.abs(afterBuy.json.balance - 985.05),
      "domain debit must be exactly $14.95",
    ).toBeLessThan(0.01);

    // ── e. Enable monetization (inference markup + purchase share). ─────────
    const monetization = await authed(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 100,
        purchaseSharePercentage: 10,
      },
    );
    expect([200, 201]).toContain(monetization.status);

    // Read it back: monetization is durably enabled, not just accepted.
    const monetizationState = await authed<AppMonetizationResponse>(
      "GET",
      `/api/v1/apps/${appId}/monetization`,
    );
    expect(monetizationState.status).toBe(200);
    expect(
      monetizationState.json.monetization?.monetizationEnabled,
      "monetization must read back as enabled",
    ).toBe(true);

    // ── f. Charge: simulate one paid inference's billing effects. ───────────
    // A real-LLM charge (end-user org debit + creator markup) is covered by
    // `creator-monetization-journey.spec.ts` behind CEREBRAS_API_KEY. Here we
    // assert the deterministic ledger effects directly: the org is debited and
    // the matching creator earning is recorded.
    const balanceBeforeCharge = afterBuy.json.balance;
    const earnBeforeCharge =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;

    const charge = await creditsService.deductCredits({
      organizationId: seededUser.organizationId,
      amount: CHARGE_USD,
      description: "simulated monetized inference charge",
      metadata: { appId },
    });
    expect(charge.success, "charge must debit the org").toBe(true);
    expect(
      Math.abs(charge.newBalance - (balanceBeforeCharge - CHARGE_USD)),
      "charge debited exactly $0.50 from the org balance",
    ).toBeLessThan(0.01);

    const earn = await redeemableEarningsService.addEarnings({
      userId: seededUser.userId,
      amount: CHARGE_USD,
      source: "app_owner_revenue_share",
      sourceId: appId,
      description: "creator markup from monetized inference charge",
      metadata: { appId },
    });
    expect(earn.success, "creator earnings ledger entry must be recorded").toBe(
      true,
    );
    expect(earn.ledgerEntryId, "earnings ledger entry id returned").toBeTruthy();

    const earnAfterCharge =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    expect(
      Math.abs(earnAfterCharge - (earnBeforeCharge + CHARGE_USD)),
      "creator redeemable balance rose by exactly the markup",
    ).toBeLessThan(1e-9);

    // ── g. Autoscale: daemon-driven node-autoscale tick replenishes pool. ───
    // Trigger the control-plane mock's node-autoscale cron — the same endpoint
    // the real autoscale daemon hits — and assert the tick is observable. NOTE:
    // wiring the autoscale cron to actually call Hetzner (so a tick alone grows
    // the pool) is the real provisioning-worker `--with-daemon` lane deferred to
    // #8920 / #8921. Until then we prove the pool replenishes by standing up a
    // second node through the same provision seam as step (c).
    const autoscaleTicksBefore = controlPlane.store.getCronCount(
      "node-autoscale-tick",
    );
    // The in-process control-plane mock authenticates cron requests with the
    // bearer `test-token`, and ALSO requires `x-container-control-plane-token`
    // when CONTAINER_CONTROL_PLANE_TOKEN is set in the runner env (it is, in
    // CI). Send both so the tick is accepted regardless of that env.
    const autoscaleRes = await fetch(
      `${controlPlane.url}/api/v1/cron/node-autoscale`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "x-container-control-plane-token":
            process.env.CONTAINER_CONTROL_PLANE_TOKEN ?? "test-token",
        },
      },
    );
    expect(autoscaleRes.status, "node-autoscale cron must accept the tick").toBe(
      200,
    );
    expect(
      controlPlane.store.getCronCount("node-autoscale-tick"),
      "node-autoscale cron tick is observable",
    ).toBe(autoscaleTicksBefore + 1);

    // Replenish the pool: a second provision stands up another running node,
    // proving the autoscaler's downstream effect (creating → running, pool +1).
    const runningBeforeReplenish = runningCount();
    const replenishSandbox = controlPlane.store.createSandbox({
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
      agentId: appId,
    });
    controlPlane.store.createJob({
      type: "agent_provision",
      sandboxId: replenishSandbox.id,
      organizationId: seededUser.organizationId,
      userId: seededUser.userId,
      payload: { agentName: "full-loop-autoscale-replenish" },
    });
    const replenishTick = await controlPlane.tick();
    expect(replenishTick.failed, "replenish tick must not fail").toBe(0);
    expect(controlPlane.store.getSandbox(replenishSandbox.id)?.status).toBe(
      "running",
    );
    expect(
      runningCount(),
      "autoscale replenished the pool by exactly one running node",
    ).toBe(runningBeforeReplenish + 1);

    // ── h. Payout: redeemable balance is the payout-readiness proxy. ────────
    // The redeemable balance reflects the creator's accrued earnings and is the
    // available payout-readiness signal. The actual fiat transfer is skipped —
    // no fiat payout mechanism exists (only Solana/EVM redemption).
    const payoutReadyBalance =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    expect(
      payoutReadyBalance,
      "creator has a positive redeemable (payout-ready) balance",
    ).toBeGreaterThanOrEqual(CHARGE_USD);
  });

  // Stripe Connect fiat payout deferred to #8922 — no fiat transfer mechanism
  // exists in this codebase (only Solana/EVM on-chain redemption). The earnings
  // ledger that a fiat payout would draw from is asserted in step (f) above;
  // the redeemable balance is asserted as the payout-readiness proxy in step
  // (h). This block stays skipped (not deleted) so the missing lane is visible
  // in the report instead of silently absent. Do NOT fake a Stripe transfer.
  test.skip("creator withdraws earnings via Stripe Connect fiat payout (#8922)", () => {
    // Intentionally empty: implement once #8922 lands a Stripe Connect transfer
    // path. It would assert: connect-account onboarding → payout request →
    // redeemable balance locked → fiat transfer settled → balance drawn down.
  });
});
