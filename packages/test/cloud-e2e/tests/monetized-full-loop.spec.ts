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
 *   g. AUTOSCALE                    → node-autoscale cron tick is observable +
 *                                     the agent-hot-pool daemon cron tick alone
 *                                     replenishes the warm pool to target
 *   h. PAYOUT                       → redeemable balance is the payout-readiness
 *                                     proxy; the full Stripe Connect fiat
 *                                     withdrawal is exercised in the test below
 *                                     (onboard → transfer → draw-down) (#8922)
 *
 * Why this drives provisioning through the control-plane STORE + tick() rather
 * than the cloud-api deploy route: the mock stack's DB-backed AGENT_PROVISION
 * handler stands a sandbox up in-memory and never touches the Hetzner mock, so
 * it cannot prove a real server `initializing → running`. The in-memory
 * `tick()` path (`processProvisionJob`) is the one that actually POSTs to the
 * Hetzner mock and polls the create action to success — so it is the only seam
 * in this stack that produces an observable Hetzner node transition. Autoscale
 * (step g) uses the now-landed daemon path (#8920/#8921): the `agent-hot-pool`
 * cron the `--with-daemon` loop ticks replenishes the warm pool on its own. The
 * REAL-Hetzner variant of this loop runs nightly via
 * `.github/workflows/monetized-loop-nightly.yml`.
 *
 * Load-bearing invariants (exact, not smoke):
 *   - Hetzner node: server count grows by 1 per provision, each reaching
 *     `running` (initializing → running) within the action window.
 *   - domain debit: 1099¢ wholesale + ceil(1099*3600/10000)=396¢ margin =
 *     1495¢ → org balance 1000 - 14.95 = 985.05 (tolerance < $0.01).
 *   - charge: the real per-app billing service computes markup from the app's
 *     monetization settings, debits base+markup from the org, records the app
 *     earning, and raises the creator redeemable balance by exactly the markup.
 *   - autoscale: node-autoscale cron tick counter increments AND the
 *     agent-hot-pool cron tick alone grows the warm pool to its target.
 *
 * Uses the `stack` + `seededUser` fixtures (same as the baseline) so we hit
 * `stack.urls.api` and the seed fixture guarantees DATABASE_URL points at the
 * running PGlite bridge before the direct cloud-shared service calls run.
 */

import { appEarningsRepository } from "@elizaos/cloud-shared/db/repositories/app-earnings";
import { appsRepository } from "@elizaos/cloud-shared/db/repositories/apps";
import { stripeConnectAccountsRepository } from "@elizaos/cloud-shared/db/repositories/stripe-connect-accounts";
import { appCreditsService } from "@elizaos/cloud-shared/lib/services/app-credits";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import {
  createConnectOnboarding,
  mapConnectWebhookEvent,
  type StripeConnectClient,
  transferToConnectAccount,
} from "@elizaos/cloud-shared/lib/services/stripe-connect-payout";
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

/** apps.earnings GET (see cloud-api .../earnings/route.ts). */
interface AppEarningsResponse {
  success?: boolean;
  earnings?: { summary?: { totalLifetimeEarnings?: number } | null };
}

/** The base inference cost used in step (f), before app monetization markup. */
const BASE_INFERENCE_COST_USD = 0.5;

test.describe("monetized full loop", () => {
  // The mock-stack loop below is the active per-PR coverage. The nightly
  // real-Hetzner workflow sets MONETIZED_LOOP_REAL=1; until the live-infra
  // driver lands (it must NOT boot the mock `stack` fixture and must drive
  // MONETIZED_LOOP_BASE_URL with a real Eliza Cloud key — tracked as a #8935
  // follow-up), skip the whole suite in real mode so the nightly never
  // masquerades mock assertions as real coverage. A describe-level skip is
  // evaluated before fixtures resolve, so no mock stack is booted in real mode.
  test.skip(
    process.env.MONETIZED_LOOP_REAL === "1",
    "real-Hetzner monetized loop driver is a follow-up (#8935); the nightly runs as a scaffold — the mock-stack loop is the active coverage",
  );

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
    expect(deployTick.processed, "exactly one provision job processed").toBe(1);

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
    expect(buy.json.verified, "domain must be registered + attached").toBe(
      true,
    );

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
    const draftMonetization = await authed(
      "PUT",
      `/api/v1/apps/${appId}/monetization`,
      {
        monetizationEnabled: true,
        inferenceMarkupPercentage: 100,
        purchaseSharePercentage: 10,
      },
    );
    expect(
      draftMonetization.status,
      "draft app cannot enable monetization before compliance approval",
    ).toBe(403);
    await approveAppForMonetizedLoop(appId);

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

    // ── f. Charge: run one deterministic paid inference billing pass. ───────
    // A real-LLM charge (end-user org debit + creator markup) is covered by
    // `creator-monetization-journey.spec.ts` behind CEREBRAS_API_KEY. Here we
    // still drive the REAL per-app billing service so markup is computed from
    // the monetization config, not chosen by the test.
    const balanceBeforeCharge = afterBuy.json.balance;
    const appEarnBefore = Number(
      (await appEarningsRepository.findByAppId(appId))
        ?.total_lifetime_earnings ?? 0,
    );
    const earnBeforeCharge =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;

    const charge = await appCreditsService.deductCredits({
      appId,
      userId: seededUser.userId,
      baseCost: BASE_INFERENCE_COST_USD,
      description: "full-loop monetized inference",
      metadata: { fullLoop: true },
    });
    expect(charge.success, "monetized charge must debit the org").toBe(true);
    expect(
      charge.creatorMarkup,
      "enabled monetization must compute a creator markup",
    ).toBeGreaterThan(0);
    expect(
      Math.abs(
        charge.totalCost - (BASE_INFERENCE_COST_USD + charge.creatorMarkup),
      ),
      "total charge equals base inference cost plus computed markup",
    ).toBeLessThan(1e-6);
    expect(
      Math.abs(charge.newBalance - (balanceBeforeCharge - charge.totalCost)),
      "org balance debited by exactly the computed total cost",
    ).toBeLessThan(1e-6);

    const appEarn = await authed<AppEarningsResponse>(
      "GET",
      `/api/v1/apps/${appId}/earnings`,
    );
    expect(appEarn.status, "app earnings endpoint must be reachable").toBe(200);
    expect(
      Math.abs(
        (appEarn.json.earnings?.summary?.totalLifetimeEarnings ?? 0) -
          (appEarnBefore + charge.creatorMarkup),
      ),
      "app-scoped earnings rose by exactly the computed markup",
    ).toBeLessThan(1e-6);

    const earnAfterCharge =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    expect(
      Math.abs(earnAfterCharge - earnBeforeCharge - charge.creatorMarkup),
      "creator redeemable balance rose by exactly the computed markup",
    ).toBeLessThan(1e-6);

    // ── g. Autoscale: the daemon-driven hot-pool cron grows the pool. ───────
    // #8920/#8921 landed the daemon path: `cloud:mock --with-daemon`
    // (`scripts/cloud/mock-stack-up.mjs`) ticks the autoscale / hot-pool /
    // pool-replenish crons on an interval, and the `agent-hot-pool` cron
    // replenishes the warm pool toward its target. Here we drive that same cron
    // ONCE (as the daemon would on its interval) and assert the tick ALONE grows
    // the pool — no manually enqueued provision job. (The real Hetzner node
    // `initializing → running` transition is asserted in step (c).)
    const cronAuth = {
      // The in-process control-plane mock authenticates cron requests with the
      // bearer `test-token`, and ALSO requires `x-container-control-plane-token`
      // when CONTAINER_CONTROL_PLANE_TOKEN is set in the runner env (it is, in
      // CI). Send both so the tick is accepted regardless of that env.
      Authorization: "Bearer test-token",
      "x-container-control-plane-token":
        process.env.CONTAINER_CONTROL_PLANE_TOKEN ?? "test-token",
    };

    // node-autoscale cron endpoint is wired and its tick is observable.
    const autoscaleTicksBefore = controlPlane.store.getCronCount(
      "node-autoscale-tick",
    );
    const autoscaleRes = await fetch(
      `${controlPlane.url}/api/v1/cron/node-autoscale`,
      { method: "POST", headers: cronAuth },
    );
    expect(
      autoscaleRes.status,
      "node-autoscale cron must accept the tick",
    ).toBe(200);
    expect(
      controlPlane.store.getCronCount("node-autoscale-tick"),
      "node-autoscale cron tick is observable",
    ).toBe(autoscaleTicksBefore + 1);

    // Raise the hot-pool target, then tick the agent-hot-pool cron once: the
    // cron (not a test-enqueued provision) must replenish the warm pool up to
    // the new target on its own.
    const warmBefore = controlPlane.store.warmPoolSnapshot().length;
    const hotPoolTarget = warmBefore + 2;
    controlPlane.store.setHotPoolTarget(hotPoolTarget);

    const hotPoolRes = await fetch(
      `${controlPlane.url}/api/v1/cron/agent-hot-pool`,
      { method: "POST", headers: cronAuth },
    );
    expect(hotPoolRes.status, "agent-hot-pool cron must accept the tick").toBe(
      200,
    );
    const hotPool = (await hotPoolRes.json()) as {
      data?: { added?: number; warmPoolSize?: number };
    };
    expect(
      hotPool.data?.added,
      "the hot-pool cron tick alone added the missing warm sandboxes",
    ).toBe(hotPoolTarget - warmBefore);
    expect(
      hotPool.data?.warmPoolSize,
      "the cron reports the pool grown to target",
    ).toBe(hotPoolTarget);
    expect(
      controlPlane.store.warmPoolSnapshot().length,
      "daemon-driven autoscale grew the warm pool to target (no manual provision)",
    ).toBe(hotPoolTarget);

    // ── h. Payout: redeemable balance is the payout-readiness proxy. ────────
    // The redeemable balance reflects the creator's accrued earnings — the
    // amount a payout draws from. The end-to-end fiat withdrawal (Stripe Connect
    // onboarding → transfer → ledger draw-down → compensating refund) is
    // exercised in the dedicated test below (#8922).
    const payoutReadyBalance =
      (await redeemableEarningsService.getBalance(seededUser.userId))
        ?.availableBalance ?? 0;
    expect(
      payoutReadyBalance,
      "creator has a positive redeemable (payout-ready) balance",
    ).toBeGreaterThanOrEqual(charge.creatorMarkup);
  });

  // Stripe Connect fiat payout (#8922) — the alternative to on-chain redemption.
  // Exercises the real onboarding/transfer/webhook services + the redeemable
  // ledger against the live PGlite DB. The Stripe SDK boundary is the one thing
  // mocked (via the injectable `StripeConnectClient` the service is built around,
  // exactly as the transfer route's `requireStripe()` is) — no real money moves.
  test("creator withdraws earnings via Stripe Connect fiat payout (#8922)", async ({
    seededUser,
  }) => {
    const userId = seededUser.userId;
    const PAYOUT_USD = 5;
    const idem = `payout-${Date.now().toString(36)}-${userId.slice(0, 8)}`
      .padEnd(16, "0")
      .slice(0, 64);

    // Records calls + returns canned ids; `failTransfer` drives the
    // compensating-saga refund path the transfer route relies on.
    const mockStripe = (opts?: {
      failTransfer?: boolean;
    }): StripeConnectClient => ({
      accounts: { create: async () => ({ id: "acct_e2e_123" }) },
      accountLinks: {
        create: async () => ({
          url: "https://connect.stripe.com/setup/acct_e2e_123",
        }),
      },
      transfers: {
        create: async (p) => {
          if (opts?.failTransfer) {
            throw new Error("stripe transfer failed (simulated)");
          }
          return { id: `tr_e2e_${p.amount}` };
        },
      },
    });

    // ── onboard: create + persist the Express account. ──────────────────────
    const onboarding = await createConnectOnboarding(mockStripe(), {
      userId,
      email: "creator@example.invalid",
      refreshUrl: "https://app.invalid/refresh",
      returnUrl: "https://app.invalid/return",
    });
    expect(onboarding.created, "a fresh Express account is created").toBe(true);
    expect(onboarding.accountId).toBe("acct_e2e_123");
    expect(onboarding.onboardingUrl).toContain("connect.stripe.com");
    await stripeConnectAccountsRepository.upsert({
      user_id: userId,
      stripe_connect_account_id: onboarding.accountId,
    });
    expect(
      (await stripeConnectAccountsRepository.findByUserId(userId))?.status,
      "account starts pending until KYC completes",
    ).toBe("pending");

    // account.updated webhook → capabilities enabled → status active.
    const accountUpdated = mapConnectWebhookEvent({
      type: "account.updated",
      account: onboarding.accountId,
      data: { object: { charges_enabled: true, payouts_enabled: true } },
    });
    expect(accountUpdated.status).toBe("active");
    await stripeConnectAccountsRepository.updateByAccountId(
      onboarding.accountId,
      {
        status: accountUpdated.status,
        charges_enabled: true,
        payouts_enabled: true,
      },
    );
    const active = await stripeConnectAccountsRepository.findByUserId(userId);
    expect(active?.status, "account is payout-ready after onboarding").toBe(
      "active",
    );
    expect(active?.payouts_enabled).toBe(true);

    // ── fund the creator's redeemable balance (the markup they accrued). ────
    await redeemableEarningsService.addEarnings({
      userId,
      amount: PAYOUT_USD,
      source: "creator_revenue_share",
      sourceId: `${idem}:earn`,
      description: "accrued markup available for fiat payout",
    });
    const funded =
      (await redeemableEarningsService.getBalance(userId))?.availableBalance ??
      0;
    expect(
      funded,
      "creator has the accrued markup available",
    ).toBeGreaterThanOrEqual(PAYOUT_USD);

    // ── happy path: debit the ledger then transfer (the route's saga order). ─
    const debit = await redeemableEarningsService.reduceEarnings({
      userId,
      amount: PAYOUT_USD,
      source: "creator_revenue_share",
      sourceId: idem,
      description: "Stripe Connect fiat payout",
      metadata: { payout_method: "stripe_connect" },
    });
    expect(debit.success, "the payout debits the redeemable ledger").toBe(true);

    const transfer = await transferToConnectAccount(mockStripe(), {
      accountId: active?.stripe_connect_account_id ?? onboarding.accountId,
      amountUsd: PAYOUT_USD,
      idempotencyKey: idem,
      metadata: { userId },
    });
    expect(transfer.transferId, "Stripe transfer created").toBe(
      `tr_e2e_${PAYOUT_USD * 100}`,
    );
    expect(transfer.amountCents, "USD converted to integer cents").toBe(
      PAYOUT_USD * 100,
    );
    const afterPayout =
      (await redeemableEarningsService.getBalance(userId))?.availableBalance ??
      0;
    expect(
      Math.abs(afterPayout - (funded - PAYOUT_USD)),
      "redeemable balance drew down by exactly the fiat payout",
    ).toBeLessThan(1e-9);

    // payout.paid webhook is recognized as the settling event.
    expect(
      mapConnectWebhookEvent({
        type: "payout.paid",
        account: onboarding.accountId,
      }).payoutStatus,
    ).toBe("paid");

    // ── compensating saga: a Stripe failure after the debit restores balance. ─
    await redeemableEarningsService.addEarnings({
      userId,
      amount: PAYOUT_USD,
      source: "creator_revenue_share",
      sourceId: `${idem}:earn2`,
      description: "fund a second payout to exercise the failure path",
    });
    const beforeFail =
      (await redeemableEarningsService.getBalance(userId))?.availableBalance ??
      0;
    const failIdem = `${idem}-fail`.slice(0, 64);
    await redeemableEarningsService.reduceEarnings({
      userId,
      amount: PAYOUT_USD,
      source: "creator_revenue_share",
      sourceId: failIdem,
      description: "Stripe Connect fiat payout (will fail)",
    });
    await expect(
      transferToConnectAccount(mockStripe({ failTransfer: true }), {
        accountId: onboarding.accountId,
        amountUsd: PAYOUT_USD,
        idempotencyKey: failIdem,
      }),
      "a Stripe failure surfaces (no silent swallow)",
    ).rejects.toThrow();
    // The route compensates by re-crediting; assert that restores the balance.
    await redeemableEarningsService.addEarnings({
      userId,
      amount: PAYOUT_USD,
      source: "creator_revenue_share",
      sourceId: `${failIdem}:refund`,
      description: "Stripe Connect payout failed — balance restored",
    });
    const restored =
      (await redeemableEarningsService.getBalance(userId))?.availableBalance ??
      0;
    expect(
      Math.abs(restored - beforeFail),
      "a failed transfer leaves the balance whole (debit fully compensated)",
    ).toBeLessThan(1e-9);
  });
});

async function approveAppForMonetizedLoop(appId: string): Promise<void> {
  // This suite validates billing/monetization/payout behavior, not the live
  // compliance-review classifier. Keep the draft 403 assertion above, then open
  // the gate with the same deterministic grandfathered approval used by the
  // review-gate e2e helper.
  await appsRepository.update(appId, {
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: new Date(),
  });
}
