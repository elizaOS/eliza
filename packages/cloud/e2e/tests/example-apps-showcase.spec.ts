/**
 * Example-apps showcase e2e (cloud:mock) — issue #9300.
 *
 * Continuously proves our two flagship monetized example apps —
 * **EDAD** (`packages/examples/cloud/edad`) and
 * **Clone Ur Crush** (`packages/examples/cloud/clone-ur-crush`) — work end to end
 * on Eliza Cloud, driven by a single CI **showcase account** funded with
 * effectively-infinite credits (see `src/helpers/showcase.ts`).
 *
 * For EACH app, with an explicit, observable assertion at every hop — and every
 * monetary value OBSERVED from the real product code, never supplied by the test:
 *
 *   1. register the app                 → `POST /api/v1/apps` returns an app id
 *   2. enable monetization              → `PUT …/monetization` (markup + share),
 *                                          read back `monetizationEnabled: true`.
 *                                          Done BEFORE the charge so it is the
 *                                          thing that produces the markup.
 *   3. DEPLOY via the real route        → `POST /api/v1/apps/:id/deploy` → poll
 *                                          the DB-backed APP_DEPLOY worker to
 *                                          READY; the deploy ITSELF creates the
 *                                          container row + stamps `production_url`,
 *                                          and that URL actually serves (fetch 200).
 *                                          The app flips local → remote/deployed.
 *   4. APP SUBDOMAIN gate               → the deploy's real container gets the
 *                                          production `<shortid>.apps.elizacloud.ai`
 *                                          host (`deriveAppPublicUrl`), and the
 *                                          Caddy on-demand-TLS gate
 *                                          (`/api/v1/apps-ingress/ask`) authorizes
 *                                          a cert for the LIVE app host (200) while
 *                                          refusing an unknown host (404).
 *   5. MONETIZED TRANSACTION + EARNING  → `appCreditsService.deductCredits` (the
 *                                          REAL per-app inference-billing service)
 *                                          computes the markup FROM the app's
 *                                          monetization settings, debits the org,
 *                                          and credits the creator. We then assert
 *                                          the org debit, the app-scoped earnings,
 *                                          and the creator's REDEEMABLE balance all
 *                                          moved by exactly the markup the service
 *                                          computed. Disabling monetization would
 *                                          zero the markup and fail these — so the
 *                                          loop proves the binding, not arithmetic
 *                                          the test chose.
 *
 * Plus account-level invariants the showcase exists to guarantee:
 *   - login/auth gate: an unauthenticated balance read is 401/403; the showcase
 *     key's read is 200 (the apps sign users in before they can spend).
 *   - infinite credits: after both apps' charges the balance is still ≥ the grant
 *     (never runs dry) yet dropped by EXACTLY the sum of the two computed charges.
 *   - one account, both apps: the single showcase creator's redeemable balance
 *     equals the SUM of both apps' computed markups; the apps got distinct ids,
 *     distinct production URLs, and distinct subdomains.
 *
 * The deploy is driven through the real cloud-api deploy route against the
 * mock-backed apps worker (the same path `remote-app-deploy.spec.ts` exercises,
 * #9145): `POST /deploy` enqueues an APP_DEPLOY job; the in-process control-plane
 * mock's DB-backed worker creates the container + reachable `production_url`. The
 * billing/earnings services are the real ones, run against the live PGlite DB.
 *
 * The REAL-staging variant (deploy to live Eliza Cloud from CI on the real
 * showcase account) activates the moment `MONETIZED_LOOP_REAL=1` + secrets exist —
 * see `.github/workflows/monetized-loop-nightly.yml` and
 * `docs/showcase-apps-coverage.md`. Until then this mock-stack loop is the active
 * coverage and never masquerades a mock assertion as real.
 */

import { randomUUID } from "node:crypto";
import { appEarningsRepository } from "@elizaos/cloud-shared/db/repositories/app-earnings";
import { appsRepository } from "@elizaos/cloud-shared/db/repositories/apps";
import { containersRepository } from "@elizaos/cloud-shared/db/repositories/containers";
import { appCreditsService } from "@elizaos/cloud-shared/lib/services/app-credits";
import {
  type AppDeploymentStatus,
  appKindFor,
} from "@elizaos/cloud-shared/lib/services/app-deployments-helpers";
import { deriveAppPublicUrl } from "@elizaos/cloud-shared/lib/services/app-url";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import type { RunningControlPlaneMock } from "@elizaos/cloud-test-mocks/control-plane";
import { authedClient } from "../src/helpers/monetization";
import {
  SHOWCASE_CREDIT_GRANT_USD,
  seedShowcaseAccount,
} from "../src/helpers/showcase";
import { expect, test } from "../src/helpers/test-fixtures";

// API-only stack (this loop never drives a browser) — skip the apex Vite boot.
test.use({ stackOptions: { frontend: false } });

// The apps share a public data-plane base domain on real staging
// (CONTAINERS_PUBLIC_BASE_DOMAIN = apps.elizacloud.ai). The test sets it in THIS
// process (with save/restore, so it can't leak into a sibling spec sharing the
// worker) so `deriveAppPublicUrl` (which reads it live via getCloudAwareEnv)
// yields the real production subdomain shape; the cloud-api subprocess only needs
// the stored `public_hostname` to answer the ingress `ask` gate.
const APPS_BASE_DOMAIN = "apps.elizacloud.ai";

/** apps.create / apps.get envelope (see cloud-api .../apps/route.ts). */
interface AppSummary {
  id: string;
  app_url: string;
  allowed_origins: string[];
  deployment_status: AppDeploymentStatus;
  production_url: string | null;
}
interface AppEnvelope {
  success?: boolean;
  app?: AppSummary;
}

/** apps.deploy / deploy-status envelope (see .../apps/[id]/deploy/route.ts). */
interface DeployEnvelope {
  success?: boolean;
  deploymentId?: string | null;
  status?: "BUILDING" | "READY" | "ERROR" | "DRAFT";
  vercelUrl?: string | null;
}

/** The deployed mock app container's self-report (control-plane mock). */
interface MockAppEnvelope {
  success?: boolean;
  appId?: string;
  runtime?: string;
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

/** redemptions.balance GET (see cloud-api .../redemptions/balance/route.ts). */
interface RedemptionBalanceResponse {
  success?: boolean;
  balance?: { availableBalance?: number };
}

/** The two flagship example apps this loop continuously proves. */
const SHOWCASE_APPS = [
  { key: "edad", name: "eDad Showcase", appUrl: "https://edad.example" },
  {
    key: "clone-ur-crush",
    name: "Clone Ur Crush Showcase",
    appUrl: "https://cloneurcrush.example",
  },
] as const;

/** Per-app inference base cost (USD). The markup is COMPUTED, never hardcoded. */
const BASE_COST_USD = 0.2;
/** Inference markup the creator sets in step 2; the service applies it in step 5. */
const MARKUP_PCT = 100;

type Authed = ReturnType<typeof authedClient>;

interface AppLoopResult {
  appId: string;
  productionUrl: string;
  hostname: string;
  totalCost: number;
  markup: number;
}

test.describe("example apps showcase (EDAD + Clone Ur Crush)", () => {
  // Set the apps base domain for this process with save/restore so a sibling
  // spec sharing the worker never sees a leaked CONTAINERS_PUBLIC_BASE_DOMAIN.
  const priorAppsBaseDomain = process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
  test.beforeAll(() => {
    process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = APPS_BASE_DOMAIN;
  });
  test.afterAll(() => {
    if (priorAppsBaseDomain === undefined) {
      delete process.env.CONTAINERS_PUBLIC_BASE_DOMAIN;
    } else {
      process.env.CONTAINERS_PUBLIC_BASE_DOMAIN = priorAppsBaseDomain;
    }
  });

  // The mock-stack loop below is the active per-PR + nightly coverage. The real-
  // staging showcase driver (deploy to live Eliza Cloud on the real showcase
  // account) is wired behind MONETIZED_LOOP_REAL=1; until that driver + secrets
  // land it must NOT boot the mock `stack` fixture, so skip at the describe level
  // (evaluated before fixtures resolve) rather than larp mock assertions as real.
  test.skip(
    process.env.MONETIZED_LOOP_REAL === "1",
    "real-staging showcase driver is a follow-up (#9300); the nightly runs the mock-stack loop as the active coverage",
  );

  test("showcase account deploys + monetizes both apps end to end", async ({
    stack,
  }) => {
    const api = stack.urls.api;
    const controlPlane = stack.mocks.controlPlane;
    const pgliteUrl = stack.urls.pglite;

    // 0. Fail legibly if the stack isn't up before any loop step runs.
    const health = await fetch(`${api}/api/health`);
    expect(health.status, "stack /api/health must be reachable").toBe(200);

    // ── login / auth gate: the apps require a signed-in user to spend. ────────
    const unauth = await fetch(`${api}/api/v1/credits/balance`);
    expect(
      [401, 403],
      "unauthenticated balance read must be denied (login required)",
    ).toContain(unauth.status);

    // ── showcase account: effectively-infinite credits via the REAL ledger. ───
    const showcase = await seedShowcaseAccount();
    const authed: Authed = authedClient(api, showcase.apiKey);

    const startBalance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(
      startBalance.status,
      "showcase key authenticates (login works)",
    ).toBe(200);
    expect(
      startBalance.json.balance,
      "showcase account is funded with effectively-infinite credits",
    ).toBeGreaterThanOrEqual(SHOWCASE_CREDIT_GRANT_USD);

    const results: AppLoopResult[] = [];
    for (const app of SHOWCASE_APPS) {
      results.push(
        await deployAndMonetizeApp({
          api,
          authed,
          showcase,
          app,
          controlPlane,
          pgliteUrl,
        }),
      );
    }

    // ── one account, both apps: aggregate invariants. ─────────────────────────
    expect(results.length, "both showcase apps ran the full loop").toBe(2);
    expect(
      new Set(results.map((r) => r.appId)).size,
      "the two apps are distinct app ids",
    ).toBe(2);
    expect(
      new Set(results.map((r) => r.productionUrl)).size,
      "the two apps got distinct production URLs",
    ).toBe(2);
    expect(
      new Set(results.map((r) => r.hostname)).size,
      "the two apps got distinct subdomains",
    ).toBe(2);

    const totalSpent = results.reduce((s, r) => s + r.totalCost, 0);
    const totalMarkup = results.reduce((s, r) => s + r.markup, 0);
    expect(
      totalMarkup,
      "both apps produced a positive creator markup",
    ).toBeGreaterThan(0);

    // The single showcase creator's redeemable balance equals the SUM of both
    // apps' computed markups (payout-ready), to the cent.
    const finalRedeemable = await authed<RedemptionBalanceResponse>(
      "GET",
      "/api/v1/redemptions/balance",
    );
    expect(finalRedeemable.status).toBe(200);
    expect(
      Math.abs(
        (finalRedeemable.json.balance?.availableBalance ?? 0) - totalMarkup,
      ),
      "creator's redeemable balance equals both apps' markups exactly",
    ).toBeLessThan(1e-6);

    // The account never ran dry — yet the real ledger dropped by EXACTLY the sum
    // of the two computed charges (no slack).
    const endBalance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(
      Math.abs(
        endBalance.json.balance - (startBalance.json.balance - totalSpent),
      ),
      "showcase credits dropped by exactly the two computed charges",
    ).toBeLessThan(1e-6);
    expect(
      endBalance.json.balance,
      "showcase credits stay effectively infinite across the run",
    ).toBeGreaterThanOrEqual(SHOWCASE_CREDIT_GRANT_USD);
  });
});

/**
 * Run the full register → monetize → deploy → subdomain → charge → earn loop for
 * one app, asserting every hop against OBSERVED values. Returns the app id, its
 * deployed production URL + subdomain, and the computed charge + markup.
 */
async function deployAndMonetizeApp(ctx: {
  api: string;
  authed: Authed;
  showcase: Awaited<ReturnType<typeof seedShowcaseAccount>>;
  app: (typeof SHOWCASE_APPS)[number];
  controlPlane: RunningControlPlaneMock;
  pgliteUrl: string;
}): Promise<AppLoopResult> {
  const { api, authed, showcase, app, controlPlane, pgliteUrl } = ctx;

  // ── 1. register the app. ────────────────────────────────────────────────
  const created = await authed<AppEnvelope>("POST", "/api/v1/apps", {
    name: `${app.name} ${Date.now().toString(36)}`,
    app_url: app.appUrl,
    allowed_origins: [app.appUrl],
    skipGitHubRepo: true,
  });
  expect([200, 201], `${app.name}: app registers`).toContain(created.status);
  const appId = created.json.app?.id;
  expect(appId, `${app.name}: apps.create returns an id`).toBeTruthy();
  if (!appId) throw new Error(`${app.name}: apps.create did not return an id`);

  // New apps must pass the compliance-review gate before monetization opens.
  const draftMonetize = await authed(
    "PUT",
    `/api/v1/apps/${appId}/monetization`,
    {
      monetizationEnabled: true,
      inferenceMarkupPercentage: MARKUP_PCT,
      purchaseSharePercentage: 10,
    },
  );
  expect(
    draftMonetize.status,
    `${app.name}: draft app cannot enable monetization before review`,
  ).toBe(403);

  await approveAppForShowcaseMonetization(appId);

  // ── 2. enable monetization BEFORE the charge (it must drive the markup). ──
  const monetize = await authed("PUT", `/api/v1/apps/${appId}/monetization`, {
    monetizationEnabled: true,
    inferenceMarkupPercentage: MARKUP_PCT,
    purchaseSharePercentage: 10,
  });
  expect([200, 201], `${app.name}: monetization update accepted`).toContain(
    monetize.status,
  );
  const monetizationState = await authed<AppMonetizationResponse>(
    "GET",
    `/api/v1/apps/${appId}/monetization`,
  );
  expect(
    monetizationState.json.monetization?.monetizationEnabled,
    `${app.name}: monetization reads back as enabled`,
  ).toBe(true);

  // ── 3. deploy through the REAL deploy route (mock-backed APP_DEPLOY worker). ─
  const started = await authed<DeployEnvelope>(
    "POST",
    `/api/v1/apps/${appId}/deploy`,
  );
  expect(started.status, `${app.name}: deploy accepted`).toBe(202);
  expect(started.json.status).toBe("BUILDING");

  let latest: DeployEnvelope | undefined;
  for (let i = 0; i < 20; i++) {
    const processed = await controlPlane.processDbBackedJobs(pgliteUrl);
    expect(
      processed.failed,
      `${app.name}: deploy worker failed: ${JSON.stringify(processed.errors)}`,
    ).toBe(0);
    const status = await authed<DeployEnvelope>(
      "GET",
      `/api/v1/apps/${appId}/deploy/status`,
    );
    expect(status.status).toBe(200);
    latest = status.json;
    if (latest.status === "READY") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(latest?.status, `${app.name}: deploy reaches READY`).toBe("READY");
  const productionUrl = latest?.vercelUrl;
  expect(
    productionUrl,
    `${app.name}: deploy exposes a production_url`,
  ).toBeTruthy();
  if (!productionUrl) {
    throw new Error(`${app.name}: deploy did not return a production_url`);
  }

  // The app row reflects the deploy: local definition → deployed remote runtime.
  const deployed = await authed<AppEnvelope>("GET", `/api/v1/apps/${appId}`);
  expect(deployed.json.app?.deployment_status).toBe("deployed");
  expect(deployed.json.app?.production_url).toBe(productionUrl);
  expect(
    deployed.json.app && appKindFor(deployed.json.app),
    `${app.name}: deployed app is remote`,
  ).toBe("remote");

  // The deployed link actually serves — no dead end.
  const live = await fetch(productionUrl);
  expect(live.status, `${app.name}: deployed production_url is reachable`).toBe(
    200,
  );
  const liveJson = (await live.json()) as MockAppEnvelope;
  expect(liveJson).toMatchObject({
    success: true,
    appId,
    runtime: "mock-app-container",
  });

  // ── 4. app subdomain — the ingress on-demand-TLS gate authorizes the live
  //       app's apps-subdomain and refuses unknown hosts. ────────────────────
  const container = await containersRepository.findActiveByProjectName(
    showcase.organizationId,
    appId,
  );
  expect(
    container,
    `${app.name}: deploy created a container bound to the app`,
  ).toBeTruthy();
  if (!container) throw new Error(`${app.name}: deploy created no container`);

  const endpoint = deriveAppPublicUrl(container.id);
  expect(
    endpoint,
    `${app.name}: app public URL derives (apps base domain configured)`,
  ).not.toBeNull();
  if (!endpoint) throw new Error(`${app.name}: app public URL did not derive`);
  expect(
    endpoint.hostname.endsWith(`.${APPS_BASE_DOMAIN}`),
    `${app.name}: subdomain lives on the apps data plane`,
  ).toBe(true);

  // Production stamps `public_hostname` via deriveAppPublicUrl when the apps base
  // domain is configured; the mock deploy omits it, so stamp it on the deploy's
  // real container to exercise the gate against a genuinely live app row.
  await containersRepository.update(container.id, showcase.organizationId, {
    public_hostname: endpoint.hostname,
  });
  const ask = await fetch(
    `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(endpoint.hostname)}`,
  );
  expect(
    ask.status,
    `${app.name}: ingress authorizes the live app subdomain (TLS cert)`,
  ).toBe(200);
  const askUnknown = await fetch(
    `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(
      `${randomUUID().slice(0, 8)}.${APPS_BASE_DOMAIN}`,
    )}`,
  );
  expect(
    askUnknown.status,
    `${app.name}: ingress refuses an unknown host (no cert abuse)`,
  ).toBe(404);

  // ── 5. monetized transaction + creator earning — driven by the REAL per-app
  //       billing service so the markup is COMPUTED from the monetization config,
  //       not chosen by the test. ─────────────────────────────────────────────
  const balanceBefore = (
    await authed<CreditBalanceResponse>("GET", "/api/v1/credits/balance")
  ).json.balance;
  const appEarnBefore = Number(
    (await appEarningsRepository.findByAppId(appId))?.total_lifetime_earnings ??
      0,
  );
  const redeemBefore =
    (await redeemableEarningsService.getBalance(showcase.userId))
      ?.availableBalance ?? 0;

  const charge = await appCreditsService.deductCredits({
    appId,
    userId: showcase.userId,
    baseCost: BASE_COST_USD,
    description: `${app.name}: monetized inference`,
    metadata: { showcase: true },
  });
  expect(charge.success, `${app.name}: monetized charge succeeds`).toBe(true);
  // Enabling monetization in step 2 is what produced this markup — disabling it
  // would zero `creatorMarkup` and fail the earnings assertions below.
  expect(
    charge.creatorMarkup,
    `${app.name}: enabled monetization produced a creator markup`,
  ).toBeGreaterThan(0);
  expect(
    Math.abs(charge.totalCost - (BASE_COST_USD + charge.creatorMarkup)),
    `${app.name}: total charge = base + computed markup`,
  ).toBeLessThan(1e-6);

  // The org was debited by EXACTLY the computed total.
  const balanceAfter = (
    await authed<CreditBalanceResponse>("GET", "/api/v1/credits/balance")
  ).json.balance;
  expect(
    Math.abs(balanceBefore - balanceAfter - charge.totalCost),
    `${app.name}: org debited exactly the computed total`,
  ).toBeLessThan(1e-6);

  // App-scoped earnings rose by EXACTLY the computed markup (observed).
  const appEarn = await authed<AppEarningsResponse>(
    "GET",
    `/api/v1/apps/${appId}/earnings`,
  );
  expect(appEarn.status, `${app.name}: app earnings endpoint reachable`).toBe(
    200,
  );
  expect(
    Math.abs(
      (appEarn.json.earnings?.summary?.totalLifetimeEarnings ?? 0) -
        (appEarnBefore + charge.creatorMarkup),
    ),
    `${app.name}: app-scoped earnings rose by exactly the markup`,
  ).toBeLessThan(1e-6);

  // The creator's redeemable balance rose by EXACTLY the computed markup.
  const redeemAfter =
    (await redeemableEarningsService.getBalance(showcase.userId))
      ?.availableBalance ?? 0;
  expect(
    Math.abs(redeemAfter - redeemBefore - charge.creatorMarkup),
    `${app.name}: creator redeemable rose by exactly the markup`,
  ).toBeLessThan(1e-6);

  return {
    appId,
    productionUrl,
    hostname: endpoint.hostname,
    totalCost: charge.totalCost,
    markup: charge.creatorMarkup,
  };
}

async function approveAppForShowcaseMonetization(appId: string): Promise<void> {
  // This spec validates deploy + billing + earnings, not the live review model.
  // Mirror the review-gate e2e helper's deterministic "grandfathered approval"
  // so the monetization path opens while the draft 403 above keeps the gate visible.
  await appsRepository.update(appId, {
    review_status: "approved",
    review_content_hash: null,
    reviewed_at: new Date(),
  });
}
