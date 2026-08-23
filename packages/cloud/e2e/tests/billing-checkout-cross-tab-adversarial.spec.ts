/**
 * Proves two real Billing tabs converge on one durable card-checkout intent.
 *
 * Both pages share one authenticated BrowserContext and drive the shipped
 * `/cloud/billing` form against the real local Worker and PGlite database. The
 * only simulated external boundary is the stack's loopback Stripe-compatible
 * provider; Playwright never intercepts or fulfills browser traffic.
 */

import { dbWrite } from "@elizaos/cloud-shared/db/helpers";
import { stripeCheckoutOrders } from "@elizaos/cloud-shared/db/schemas/stripe-checkout-orders";
import type { BrowserContext, Page, Request } from "@playwright/test";
import {
  createCloudAgent,
  getPersistedAgentSummary,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

const CHECKOUT_PATH = "/api/stripe/create-checkout-session";
const BILLING_PATH = "/cloud/billing";
const CHECKOUT_AMOUNT = "17";
const CHECKOUT_AMOUNT_CENTS = 1_700;
const CARD_CHECKOUT_INTENT_STORAGE_PREFIX =
  "eliza:billing:card-checkout-intent:v1:";

const SHELL_PATHS = [
  "/api/health",
  "/api/status",
  "/api/auth/status",
  "/api/auth/me",
  "/api/conversations",
  "/api/character",
  "/api/first-run/status",
  "/api/first-run",
  "/api/views",
  "/api/config",
  "/api/runtime/mode",
  "/api/commands",
  "/api/custom-actions",
  "/api/agent/events",
  "/api/agent/start",
  "/api/apps/overlay-presence",
  "/api/lifeops/activity-signals",
  "/api/stream/settings",
] as const;

interface PersistedCheckoutIntent {
  version?: unknown;
  organizationId?: unknown;
  initiatedByUserId?: unknown;
  amountCents?: unknown;
  idempotencyKey?: unknown;
  sessionId?: unknown;
}

function isCheckoutRequest(request: Request): boolean {
  return (
    request.method() === "POST" &&
    new URL(request.url()).pathname === CHECKOUT_PATH
  );
}

function isFakeStripeNavigation(request: Request): boolean {
  return (
    request.isNavigationRequest() &&
    new URL(request.url()).hostname === "checkout.stripe.test"
  );
}

async function openBillingTab(page: Page, frontendUrl: string): Promise<void> {
  await page.goto(`${frontendUrl}${BILLING_PATH}`, {
    timeout: 60_000,
    waitUntil: "domcontentloaded",
  });
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/);
  await expect(page).toHaveURL(new RegExp(`${BILLING_PATH}$`));
  await expect(page.getByLabel("Amount (USD)", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByRole("button", { name: "Buy credits", exact: true }),
  ).toBeVisible();
}

async function readPersistedIntent(
  context: BrowserContext,
  frontendUrl: string,
  organizationId: string,
): Promise<PersistedCheckoutIntent> {
  const state = await context.storageState();
  const frontendOrigin = new URL(frontendUrl).origin;
  const storage = state.origins.find(
    (candidate) => candidate.origin === frontendOrigin,
  );
  expect(
    storage,
    "expected frontend localStorage in BrowserContext state",
  ).toBeDefined();
  const item = storage?.localStorage.find(
    (candidate) =>
      candidate.name ===
      `${CARD_CHECKOUT_INTENT_STORAGE_PREFIX}${organizationId}`,
  );
  expect(
    item,
    "expected one persisted checkout intent for the organization",
  ).toBeDefined();
  return JSON.parse(item?.value ?? "null") as PersistedCheckoutIntent;
}

test.use({
  stackOptions: {
    fakeStripe: true,
    backendFaults: true,
  },
});

test("two Billing tabs share one order, provider effect, and Checkout navigation", async ({
  authenticatedPage,
  seededUser,
  stack,
}, testInfo) => {
  test.setTimeout(240_000);
  const fakeStripe = stack.mocks.stripe;
  expect(fakeStripe, "fake Stripe must be booted for this lane").toBeDefined();
  if (!fakeStripe) throw new Error("fake Stripe was not booted");

  const backendFaults = stack.mocks.backendFaults;
  expect(
    backendFaults,
    "the real app shell requires the server-side path-rewrite controller",
  ).toBeDefined();
  if (!backendFaults) throw new Error("backend fault controller unavailable");
  backendFaults.clearFault();

  // The combined app expects its shell API at the active runtime. A real
  // shared agent supplies that API while account and Billing calls continue to
  // hit the Worker root through the server-side proxy.
  const agentId = await createCloudAgent(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    `billing-two-tab-e2e-${Date.now().toString(36)}`,
  );
  const shellRuntime = await getPersistedAgentSummary(
    agentId,
    seededUser.organizationId,
  );
  expect(shellRuntime.executionTier).toBe("shared");
  const sharedAdapterPrefix = `/api/v1/eliza/agents/${encodeURIComponent(agentId)}`;
  backendFaults.setPathRewrites(
    SHELL_PATHS.map((path) => ({
      path,
      targetPath: `${sharedAdapterPrefix}${path}`,
    })),
  );

  const context = authenticatedPage.context();
  const firstTab = authenticatedPage;
  const secondTab = await context.newPage();
  expect(secondTab.context()).toBe(firstTab.context());

  await context.addInitScript(
    ({ agentId, apiBase, apiKey }) => {
      window.localStorage.setItem("eliza:first-run-complete", "1");
      window.localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: `cloud:${agentId}`,
          kind: "cloud",
          label: "Billing two-tab E2E shared runtime",
          apiBase,
          accessToken: apiKey,
          cloudRuntimeAgentId: agentId,
          cloudRuntime: "shared",
        }),
      );
    },
    {
      agentId,
      apiBase: stack.urls.frontend,
      apiKey: seededUser.apiKey,
    },
  );

  // Warm the real shell once so startup and lazy private-route registration
  // settle before both tabs enter Billing together.
  const runtimeReady = firstTab.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/status" &&
      response.status() === 200,
    { timeout: 60_000 },
  );
  await firstTab.goto(stack.urls.frontend, { timeout: 60_000 });
  await runtimeReady;
  await expect(firstTab.getByTestId("home-launcher-surface")).toBeVisible();

  await Promise.all([
    openBillingTab(firstTab, stack.urls.frontend),
    openBillingTab(secondTab, stack.urls.frontend),
  ]);
  await Promise.all([
    firstTab.getByLabel("Amount (USD)", { exact: true }).fill(CHECKOUT_AMOUNT),
    secondTab.getByLabel("Amount (USD)", { exact: true }).fill(CHECKOUT_AMOUNT),
  ]);

  const browserCheckoutRequests: Request[] = [];
  const observeCheckoutRequest = (request: Request) => {
    if (isCheckoutRequest(request)) browserCheckoutRequests.push(request);
  };
  context.on("request", observeCheckoutRequest);

  const firstRequestPromise = firstTab.waitForRequest(isCheckoutRequest);
  const secondRequestPromise = secondTab.waitForRequest(isCheckoutRequest);
  const firstResponsePromise = firstTab.waitForResponse((response) =>
    isCheckoutRequest(response.request()),
  );
  const secondResponsePromise = secondTab.waitForResponse((response) =>
    isCheckoutRequest(response.request()),
  );
  const firstNavigationPromise = firstTab.waitForRequest(
    isFakeStripeNavigation,
  );
  const secondNavigationPromise = secondTab.waitForRequest(
    isFakeStripeNavigation,
  );

  // Both real form submissions begin in the same turn. `noWaitAfter` keeps the
  // test attached while each page leaves for the intentionally non-routable
  // synthetic Stripe hostname.
  await Promise.all([
    firstTab
      .getByRole("button", { name: "Buy credits", exact: true })
      .click({ noWaitAfter: true }),
    secondTab
      .getByRole("button", { name: "Buy credits", exact: true })
      .click({ noWaitAfter: true }),
  ]);

  const [firstRequest, secondRequest, firstResponse, secondResponse] =
    await Promise.all([
      firstRequestPromise,
      secondRequestPromise,
      firstResponsePromise,
      secondResponsePromise,
    ]);
  expect(firstResponse.status()).toBe(200);
  expect(secondResponse.status()).toBe(200);

  const firstIdempotencyKey = await firstRequest.headerValue("idempotency-key");
  const secondIdempotencyKey =
    await secondRequest.headerValue("idempotency-key");
  expect(firstIdempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  expect(secondIdempotencyKey).toBe(firstIdempotencyKey);
  expect(firstRequest.postDataJSON()).toMatchObject({
    amount: Number(CHECKOUT_AMOUNT),
    expectedOrganizationId: seededUser.organizationId,
    expectedUserId: seededUser.userId,
    returnUrl: "settings",
  });
  expect(secondRequest.postDataJSON()).toEqual(firstRequest.postDataJSON());

  const [firstNavigation, secondNavigation] = await Promise.all([
    firstNavigationPromise,
    secondNavigationPromise,
  ]);
  expect(secondNavigation.url()).toBe(firstNavigation.url());
  const sessionUrl = firstNavigation.url();

  context.off("request", observeCheckoutRequest);
  expect(browserCheckoutRequests).toHaveLength(2);
  expect(browserCheckoutRequests).toEqual(
    expect.arrayContaining([firstRequest, secondRequest]),
  );

  const organizationOrders = (
    await dbWrite.select().from(stripeCheckoutOrders)
  ).filter((order) => order.organization_id === seededUser.organizationId);
  expect(organizationOrders).toHaveLength(1);
  const [order] = organizationOrders;
  if (!order) throw new Error("expected one durable Checkout order");
  const sessionId = order.stripe_checkout_session_id;
  expect(sessionId).toEqual(expect.any(String));
  if (!sessionId) throw new Error("durable Checkout order has no Session ID");
  expect(order).toMatchObject({
    organization_id: seededUser.organizationId,
    initiated_by_user_id: seededUser.userId,
    client_request_key: firstIdempotencyKey,
    purchase_type: "custom_amount",
    credits_to_grant: "17.000000",
    charge_amount_cents: 1_700n,
    currency: "usd",
    stripe_checkout_session_id: sessionId,
    status: "delivered",
  });

  const persistedIntent = await readPersistedIntent(
    context,
    stack.urls.frontend,
    seededUser.organizationId,
  );
  expect(persistedIntent).toMatchObject({
    version: 1,
    organizationId: seededUser.organizationId,
    initiatedByUserId: seededUser.userId,
    amountCents: CHECKOUT_AMOUNT_CENTS,
    idempotencyKey: firstIdempotencyKey,
    sessionId,
  });

  expect(fakeStripe.state.customers.size).toBe(1);
  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.counters.customersCreated).toBe(1);
  expect(fakeStripe.state.counters.checkoutSessionsCreated).toBe(1);
  const session = fakeStripe.state.sessions.get(sessionId);
  expect(session).toMatchObject({
    id: sessionId,
    url: sessionUrl,
    client_reference_id: order.id,
    amount_total: CHECKOUT_AMOUNT_CENTS,
    currency: "usd",
    metadata: { checkout_order_id: order.id, type: "custom_amount" },
  });
  expect(fakeStripe.state.effects[0]).toMatchObject({
    kind: "checkout.session.create",
    id: sessionId,
    idempotencyKey: `checkout-order:${order.id}`,
  });
  const providerCreates = fakeStripe.state.requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/v1/checkout/sessions",
  );
  expect(providerCreates.length).toBeGreaterThanOrEqual(1);
  expect(
    providerCreates.every(
      (request) =>
        request.headers["idempotency-key"] === `checkout-order:${order.id}`,
    ),
  ).toBe(true);

  await testInfo.attach("billing-checkout-two-tab-receipt.json", {
    body: JSON.stringify(
      {
        browser: {
          pageCount: 2,
          checkoutRequestCount: browserCheckoutRequests.length,
          responseStatuses: [firstResponse.status(), secondResponse.status()],
          requestIdempotencyKey: firstIdempotencyKey,
          checkoutSessionId: sessionId,
          navigationUrls: [firstNavigation.url(), secondNavigation.url()],
        },
        persistedIntent,
        durableOrder: {
          id: order.id,
          status: order.status,
          chargeAmountCents: order.charge_amount_cents.toString(),
          checkoutSessionId: order.stripe_checkout_session_id,
          clientRequestKey: order.client_request_key,
        },
        fakeStripe: {
          customersCreated: fakeStripe.state.counters.customersCreated,
          checkoutSessionsCreated:
            fakeStripe.state.counters.checkoutSessionsCreated,
          effectCount: fakeStripe.state.effects.length,
          providerSessionCreateRequests: providerCreates.length,
          providerIdempotencyKey: `checkout-order:${order.id}`,
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  await Promise.allSettled([firstTab.close(), secondTab.close()]);
});
