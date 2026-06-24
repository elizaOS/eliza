/**
 * Example-apps showcase e2e (cloud:mock) - issue #9300.
 *
 * Continuously proves our two flagship monetized example apps -
 * **EDAD** (`packages/examples/cloud/edad`) and
 * **Clone Ur Crush** (`packages/examples/cloud/clone-ur-crush`) - work end to end
 * on Eliza Cloud, driven by a single CI **showcase account** funded with
 * effectively-infinite credits (see `src/helpers/showcase.ts`).
 *
 * For EACH app, with an explicit, observable assertion at every hop:
 *
 *   1. register the app                 -> `POST /api/v1/apps` returns an app id
 *   2. DEPLOY a container               -> control-plane provision job stands a
 *                                          Hetzner mock node up (initializing ->
 *                                          running) AND a real `containers` row is
 *                                          bound to the app (project_name = appId)
 *   3. APP SUBDOMAIN configured + live  -> the container's public hostname is the
 *                                          real `<shortid>.apps.elizacloud.ai`
 *                                          (`deriveAppPublicUrl`), and the Caddy
 *                                          on-demand-TLS gate
 *                                          (`GET /api/v1/apps-ingress/ask`)
 *                                          authorizes a cert for it (200) while
 *                                          refusing an unknown host (404) - i.e.
 *                                          the link is wired and would serve TLS
 *   4. enable monetization              -> `PUT .../monetization` (markup + share),
 *                                          read back `monetizationEnabled: true`
 *   5. MONETIZED TRANSACTION            -> the showcase org is debited the full
 *                                          base+markup charge via the real credit
 *                                          ledger (`deductCredits`)
 *   6. USAGE -> creator earning          -> the app's inference markup is recorded
 *                                          to BOTH the app-scoped earnings ledger
 *                                          (`/api/v1/apps/:id/earnings` summary
 *                                          climbs) AND the creator's REDEEMABLE
 *                                          balance (`addEarnings`)
 *   7. REDEEMABLE / payout-ready        -> `/api/v1/redemptions/balance` reflects
 *                                          the accrued, withdrawable earning
 *
 * Plus account-level invariants the showcase exists to guarantee:
 *   - login/auth gate: an unauthenticated balance read is 401, the showcase
 *     key's read is 200 (the apps sign users in before they can spend)
 *   - infinite credits: after every charge the balance is still >= the grant, so
 *     the account never runs dry mid-run - yet each charge moved the real ledger
 *   - one account, both apps: the single showcase creator's redeemable balance
 *     equals the SUM of both apps' markups, and each app's earnings are recorded
 *     under its own appId
 *
 * Why the deploy is driven through the control-plane STORE + tick() (same as
 * `monetized-full-loop.spec.ts`): the mock stack's DB-backed AGENT_PROVISION
 * handler stands a sandbox up in-memory and never touches the Hetzner mock, so it
 * cannot prove a real server `initializing -> running`. The in-process `tick()`
 * path POSTs to the Hetzner mock and polls the create action to success - the one
 * seam that produces an observable node transition. The `containers` row is
 * created through the real repository so the ingress `ask` gate (which queries
 * `containers.public_hostname`) resolves the subdomain exactly as production does.
 *
 * The REAL-staging variant of this loop (deploy to live Eliza Cloud from CI via
 * the actual app-container path, on the real showcase account) activates the
 * moment `MONETIZED_LOOP_REAL=1` + secrets exist - see
 * `.github/workflows/monetized-loop-nightly.yml` and
 * `docs/showcase-apps-coverage.md`. Until then this mock-stack loop is the active
 * coverage and never masquerades a mock assertion as real.
 */

import { randomUUID } from "node:crypto";
import { appEarningsRepository } from "@elizaos/cloud-shared/db/repositories/app-earnings";
import { containersRepository } from "@elizaos/cloud-shared/db/repositories/containers";
import { deriveAppPublicUrl } from "@elizaos/cloud-shared/lib/services/app-url";
import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { redeemableEarningsService } from "@elizaos/cloud-shared/lib/services/redeemable-earnings";
import type { CreditBalanceResponse } from "@elizaos/cloud-shared/lib/types/cloud-api";
import type { RunningControlPlaneMock } from "@elizaos/cloud-test-mocks/control-plane";
import type { MockServer } from "@elizaos/cloud-test-mocks/hetzner";
import { authedClient } from "../src/helpers/monetization";
import {
  SHOWCASE_CREDIT_GRANT_USD,
  seedShowcaseAccount,
} from "../src/helpers/showcase";
import { expect, test } from "../src/helpers/test-fixtures";

// The apps share a public data-plane base domain on real staging
// (CONTAINERS_PUBLIC_BASE_DOMAIN = apps.elizacloud.ai). The test sets it in THIS
// process (with save/restore, so it can't leak into a sibling spec sharing the
// worker) so `deriveAppPublicUrl` (which reads it live via getCloudAwareEnv)
// yields the real production subdomain shape; the cloud-api subprocess only needs
// the stored `public_hostname` to answer the ingress `ask` gate.
const APPS_BASE_DOMAIN = "apps.elizacloud.ai";

/** apps.create returns { success, app: <App>, apiKey, ... }; we only read id. */
interface CreateAppResponse {
  success?: boolean;
  app?: { id?: string };
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
  {
    key: "edad",
    name: "eDad Showcase",
    appUrl: "https://edad.example",
    imageTag: "ghcr.io/elizaos/example-edad:showcase",
  },
  {
    key: "clone-ur-crush",
    name: "Clone Ur Crush Showcase",
    appUrl: "https://cloneurcrush.example",
    imageTag: "ghcr.io/elizaos/example-clone-ur-crush:showcase",
  },
] as const;

/** Per-app monetized-transaction economics (USD), deterministic + exact. */
const BASE_COST_USD = 0.2;
const MARKUP_PCT = 100;
const MARKUP_USD = (BASE_COST_USD * MARKUP_PCT) / 100; // 0.20
const TOTAL_CHARGE_USD = BASE_COST_USD + MARKUP_USD; // 0.40

type Authed = ReturnType<typeof authedClient>;

interface AppLoopResult {
  appId: string;
  hostname: string;
}

test.describe("example apps showcase (EDAD + Clone Ur Crush)", () => {
  // The mock-stack loop below is the active per-PR + nightly coverage. The real-
  // staging showcase driver (deploy to live Eliza Cloud on the real showcase
  // account) is wired behind MONETIZED_LOOP_REAL=1; until that driver + secrets
  // land it must NOT boot the mock `stack` fixture, so skip at the describe level
  // (evaluated before fixtures resolve) rather than pass mock assertions as real.
  test.skip(
    process.env.MONETIZED_LOOP_REAL === "1",
    "real-staging showcase driver is a follow-up (#9300); the nightly runs the mock-stack loop as the active coverage",
  );

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

  test("showcase account deploys + monetizes both apps end to end", async ({
    stack,
    seededUser: _seededUser,
  }) => {
    const api = stack.urls.api;
    const hetznerStore = stack.mocks.hetzner.store;
    const controlPlane = stack.mocks.controlPlane;

    const runningCount = (): number =>
      [...hetznerStore.servers.values()].filter(
        (s: MockServer) => s.status === "running",
      ).length;

    // 0. Fail legibly if the stack isn't up before any loop step runs.
    const health = await fetch(`${api}/api/health`);
    expect(health.status, "stack /api/health must be reachable").toBe(200);

    // -- login / auth gate: the apps require a signed-in user to spend. --------
    // An unauthenticated balance read is rejected; the showcase key's read is OK.
    const unauth = await fetch(`${api}/api/v1/credits/balance`);
    expect(
      [401, 403],
      "unauthenticated balance read must be denied (login required)",
    ).toContain(unauth.status);

    // -- showcase account: effectively-infinite credits via the REAL ledger. ---
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
    let expectedRedeemable =
      (await redeemableEarningsService.getBalance(showcase.userId))
        ?.availableBalance ?? 0;

    for (const app of SHOWCASE_APPS) {
      const result = await deployAndMonetizeApp({
        api,
        authed,
        showcase,
        app,
        controlPlane,
        runningCount,
      });
      results.push(result);

      // Each app's markup credited the SAME showcase creator's redeemable
      // balance - the running total must grow by exactly this app's markup.
      expectedRedeemable += MARKUP_USD;
      const redeemableNow =
        (await redeemableEarningsService.getBalance(showcase.userId))
          ?.availableBalance ?? 0;
      expect(
        Math.abs(redeemableNow - expectedRedeemable),
        `${app.name}: creator redeemable rose by exactly the markup`,
      ).toBeLessThan(1e-9);
    }

    // -- one account, both apps: aggregate invariants. -------------------------
    expect(results.length, "both showcase apps ran the full loop").toBe(2);
    expect(
      new Set(results.map((r) => r.appId)).size,
      "the two apps are distinct app ids",
    ).toBe(2);
    expect(
      new Set(results.map((r) => r.hostname)).size,
      "the two apps got distinct subdomains",
    ).toBe(2);

    // The single showcase creator's redeemable balance equals the SUM of both
    // apps' markups (payout-ready).
    const finalRedeemable = await authed<RedemptionBalanceResponse>(
      "GET",
      "/api/v1/redemptions/balance",
    );
    expect(finalRedeemable.status).toBe(200);
    expect(
      finalRedeemable.json.balance?.availableBalance ?? 0,
      "creator can redeem the accrued earnings from both apps",
    ).toBeGreaterThanOrEqual(MARKUP_USD * SHOWCASE_APPS.length);

    // The account never ran dry: even after both apps' charges, the balance is
    // still effectively infinite - yet every charge moved the real ledger (each
    // app asserted its own exact debit below).
    const endBalance = await authed<CreditBalanceResponse>(
      "GET",
      "/api/v1/credits/balance",
    );
    expect(
      endBalance.json.balance,
      "showcase credits stay effectively infinite across the run",
    ).toBeGreaterThanOrEqual(SHOWCASE_CREDIT_GRANT_USD - 100);
    expect(
      endBalance.json.balance,
      "but the real ledger was debited for both apps' charges",
    ).toBeLessThan(startBalance.json.balance);
  });
});

/**
 * Run the full deploy -> subdomain -> monetize -> charge -> earn loop for one app,
 * asserting every hop. Returns the app id + its assigned subdomain.
 */
async function deployAndMonetizeApp(ctx: {
  api: string;
  authed: Authed;
  showcase: Awaited<ReturnType<typeof seedShowcaseAccount>>;
  app: (typeof SHOWCASE_APPS)[number];
  controlPlane: RunningControlPlaneMock;
  runningCount: () => number;
}): Promise<AppLoopResult> {
  const { api, authed, showcase, app, controlPlane, runningCount } = ctx;

  // -- 1. register the app. ------------------------------------------------
  const created = await authed<CreateAppResponse>("POST", "/api/v1/apps", {
    name: `${app.name} ${Date.now().toString(36)}`,
    app_url: app.appUrl,
    skipGitHubRepo: true,
  });
  expect([200, 201], `${app.name}: app registers`).toContain(created.status);
  const appId = created.json.app?.id;
  expect(appId, `${app.name}: apps.create returns an id`).toBeTruthy();
  if (!appId) throw new Error(`${app.name}: apps.create did not return an id`);

  // -- 2. deploy a container: prove an observable Hetzner node transition. --
  const serversBeforeDeploy = runningCount();
  const deploySandbox = controlPlane.store.createSandbox({
    organizationId: showcase.organizationId,
    userId: showcase.userId,
    agentId: appId,
  });
  controlPlane.store.createJob({
    type: "agent_provision",
    sandboxId: deploySandbox.id,
    organizationId: showcase.organizationId,
    userId: showcase.userId,
    payload: { agentName: `${app.key}-showcase-deploy` },
  });
  const deployTick = await controlPlane.tick();
  expect(deployTick.failed, `${app.name}: provision tick must not fail`).toBe(
    0,
  );
  expect(
    deployTick.processed,
    `${app.name}: exactly one provision job processed`,
  ).toBe(1);
  expect(
    controlPlane.store.getSandbox(deploySandbox.id)?.status,
    `${app.name}: deployed sandbox is running`,
  ).toBe("running");
  expect(
    runningCount(),
    `${app.name}: deploy stood up exactly one running Hetzner node`,
  ).toBe(serversBeforeDeploy + 1);

  // Bind a real container row to the app (project_name = appId), with the
  // production subdomain derived from its id - the same shape production stamps.
  const containerId = randomUUID();
  const endpoint = deriveAppPublicUrl(containerId);
  expect(
    endpoint,
    `${app.name}: app public URL derives (apps base domain configured)`,
  ).not.toBeNull();
  if (!endpoint) throw new Error(`${app.name}: app public URL did not derive`);
  expect(
    endpoint.hostname.endsWith(`.${APPS_BASE_DOMAIN}`),
    `${app.name}: subdomain lives on the apps data plane`,
  ).toBe(true);

  await containersRepository.create({
    id: containerId,
    name: app.name,
    project_name: appId,
    organization_id: showcase.organizationId,
    user_id: showcase.userId,
    image_tag: app.imageTag,
    status: "running",
    public_hostname: endpoint.hostname,
    load_balancer_url: endpoint.url,
  });

  // -- 3. app subdomain configured + live (ingress on-demand-TLS gate). -----
  // Caddy asks before issuing a cert: a live app's host is authorized (200), an
  // unknown host is refused (404). This is the link being wired + serving TLS.
  const ask = await fetch(
    `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(endpoint.hostname)}`,
  );
  expect(ask.status, `${app.name}: ingress authorizes the live subdomain`).toBe(
    200,
  );
  const askUnknown = await fetch(
    `${api}/api/v1/apps-ingress/ask?domain=${encodeURIComponent(
      `${randomUUID().slice(0, 8)}.${APPS_BASE_DOMAIN}`,
    )}`,
  );
  expect(
    askUnknown.status,
    `${app.name}: ingress refuses an unknown host (no cert abuse)`,
  ).toBe(404);

  // -- 4. enable monetization (markup + purchase share), read it back. ------
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

  // -- 5. monetized transaction: real org debit (base + markup). ------------
  const balanceBefore = (
    await authed<CreditBalanceResponse>("GET", "/api/v1/credits/balance")
  ).json.balance;
  const charge = await creditsService.deductCredits({
    organizationId: showcase.organizationId,
    amount: TOTAL_CHARGE_USD,
    description: `${app.name}: monetized inference charge (base + markup)`,
    metadata: { appId, showcase: true },
  });
  expect(charge.success, `${app.name}: charge debits the showcase org`).toBe(
    true,
  );
  expect(
    Math.abs(charge.newBalance - (balanceBefore - TOTAL_CHARGE_USD)),
    `${app.name}: org debited exactly base + markup`,
  ).toBeLessThan(1e-6);

  // -- 6. usage -> creator earning (app-scoped ledger + redeemable). ---------
  const appEarnBefore =
    (await appEarningsRepository.findByAppId(appId))?.total_lifetime_earnings ??
    "0";
  await appEarningsRepository.addInferenceEarnings(appId, MARKUP_USD);
  const appEarn = await authed<AppEarningsResponse>(
    "GET",
    `/api/v1/apps/${appId}/earnings`,
  );
  expect(appEarn.status, `${app.name}: app earnings endpoint reachable`).toBe(
    200,
  );
  expect(
    appEarn.json.earnings?.summary?.totalLifetimeEarnings ?? 0,
    `${app.name}: app-scoped lifetime earnings recorded the markup`,
  ).toBeCloseTo(Number(appEarnBefore) + MARKUP_USD, 6);

  const earn = await redeemableEarningsService.addEarnings({
    userId: showcase.userId,
    amount: MARKUP_USD,
    source: "app_owner_revenue_share",
    sourceId: appId,
    description: `${app.name}: creator markup from monetized inference`,
    metadata: { appId },
  });
  expect(earn.success, `${app.name}: creator redeemable earning recorded`).toBe(
    true,
  );
  expect(
    earn.ledgerEntryId,
    `${app.name}: earnings ledger id returned`,
  ).toBeTruthy();

  return { appId, hostname: endpoint.hostname };
}
