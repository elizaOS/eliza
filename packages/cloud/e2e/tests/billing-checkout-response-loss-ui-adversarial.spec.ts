/**
 * Proves the real Billing UI safely replays an ambiguously failed Checkout.
 *
 * The local Stripe-compatible provider commits one Session and drops both
 * responses seen by stripe-node. The first browser submit therefore fails
 * after the provider effect, while the second submit must retain the browser
 * intent and recover that same Session through the real Worker and PGlite.
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
const CHECKOUT_AMOUNT = "19";
const CHECKOUT_AMOUNT_CENTS = 1_900;
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

async function openBillingPage(page: Page, frontendUrl: string): Promise<void> {
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

test.use({
  stackOptions: {
    fakeStripe: true,
    backendFaults: true,
  },
});

test("Billing retries a lost Checkout response onto the committed provider Session", async ({
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

  const agentId = await createCloudAgent(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    `billing-response-loss-e2e-${Date.now().toString(36)}`,
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
  await context.addInitScript(
    ({ agentId, apiBase, apiKey }) => {
      window.localStorage.setItem("eliza:first-run-complete", "1");
      window.localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: `cloud:${agentId}`,
          kind: "cloud",
          label: "Billing response-loss E2E shared runtime",
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

  const runtimeReady = authenticatedPage.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/status" &&
      response.status() === 200,
    { timeout: 60_000 },
  );
  await authenticatedPage.goto(stack.urls.frontend, { timeout: 60_000 });
  await runtimeReady;
  await expect(
    authenticatedPage.getByTestId("home-launcher-surface"),
  ).toBeVisible();

  await openBillingPage(authenticatedPage, stack.urls.frontend);
  const amountInput = authenticatedPage.getByLabel("Amount (USD)", {
    exact: true,
  });
  const buyButton = authenticatedPage.getByRole("button", {
    name: "Buy credits",
    exact: true,
  });
  await amountInput.fill(CHECKOUT_AMOUNT);

  fakeStripe.loseNextCheckoutSessionCreateResponseAfterCommit();
  const firstRequestPromise =
    authenticatedPage.waitForRequest(isCheckoutRequest);
  const firstResponsePromise = authenticatedPage.waitForResponse((response) =>
    isCheckoutRequest(response.request()),
  );
  await buyButton.click();
  const [firstRequest, firstResponse] = await Promise.all([
    firstRequestPromise,
    firstResponsePromise,
  ]);
  expect(firstResponse.status()).toBe(500);
  await expect(buyButton).toBeEnabled();
  await expect(amountInput).toHaveValue(CHECKOUT_AMOUNT);
  await expect(authenticatedPage).toHaveURL(new RegExp(`${BILLING_PATH}$`));

  const firstIdempotencyKey = await firstRequest.headerValue("idempotency-key");
  expect(firstIdempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
  expect(firstRequest.postDataJSON()).toMatchObject({
    amount: Number(CHECKOUT_AMOUNT),
    expectedOrganizationId: seededUser.organizationId,
    expectedUserId: seededUser.userId,
    returnUrl: "settings",
  });

  const ambiguousIntent = await readPersistedIntent(
    context,
    stack.urls.frontend,
    seededUser.organizationId,
  );
  expect(ambiguousIntent).toMatchObject({
    version: 1,
    organizationId: seededUser.organizationId,
    initiatedByUserId: seededUser.userId,
    amountCents: CHECKOUT_AMOUNT_CENTS,
    idempotencyKey: firstIdempotencyKey,
    sessionId: null,
  });

  const ordersAfterLoss = (
    await dbWrite.select().from(stripeCheckoutOrders)
  ).filter((order) => order.organization_id === seededUser.organizationId);
  expect(ordersAfterLoss).toHaveLength(1);
  const [ambiguousOrder] = ordersAfterLoss;
  if (!ambiguousOrder) throw new Error("expected one ambiguous Checkout order");
  expect(ambiguousOrder).toMatchObject({
    organization_id: seededUser.organizationId,
    initiated_by_user_id: seededUser.userId,
    client_request_key: firstIdempotencyKey,
    purchase_type: "custom_amount",
    credits_to_grant: "19.000000",
    charge_amount_cents: 1_900n,
    currency: "usd",
    stripe_checkout_session_id: null,
    status: "provider_ambiguous",
  });

  expect(fakeStripe.state.customers.size).toBe(1);
  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.counters.customersCreated).toBe(1);
  expect(fakeStripe.state.counters.checkoutSessionsCreated).toBe(1);
  const lostProviderResponses =
    fakeStripe.state.counters.checkoutSessionCreateResponsesLost;
  expect([1, 2]).toContain(lostProviderResponses);
  const providerCreatesAfterLoss = fakeStripe.state.requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/v1/checkout/sessions",
  );
  expect(providerCreatesAfterLoss).toHaveLength(lostProviderResponses);
  expect(
    providerCreatesAfterLoss.every(
      (request) =>
        request.headers["idempotency-key"] ===
        `checkout-order:${ambiguousOrder.id}`,
    ),
  ).toBe(true);

  const secondRequestPromise =
    authenticatedPage.waitForRequest(isCheckoutRequest);
  const secondResponsePromise = authenticatedPage.waitForResponse((response) =>
    isCheckoutRequest(response.request()),
  );
  const navigationPromise = authenticatedPage.waitForRequest(
    isFakeStripeNavigation,
  );
  await buyButton.click({ noWaitAfter: true });
  const [secondRequest, secondResponse, navigation] = await Promise.all([
    secondRequestPromise,
    secondResponsePromise,
    navigationPromise,
  ]);
  expect(secondResponse.status()).toBe(200);

  const secondIdempotencyKey =
    await secondRequest.headerValue("idempotency-key");
  expect(secondIdempotencyKey).toBe(firstIdempotencyKey);
  expect(secondRequest.postDataJSON()).toEqual(firstRequest.postDataJSON());

  const ordersAfterRecovery = (
    await dbWrite.select().from(stripeCheckoutOrders)
  ).filter((order) => order.organization_id === seededUser.organizationId);
  expect(ordersAfterRecovery).toHaveLength(1);
  const [deliveredOrder] = ordersAfterRecovery;
  if (!deliveredOrder) throw new Error("expected one delivered Checkout order");
  expect(deliveredOrder.id).toBe(ambiguousOrder.id);
  const sessionId = deliveredOrder.stripe_checkout_session_id;
  expect(sessionId).toEqual(expect.any(String));
  if (!sessionId) throw new Error("recovered Checkout order has no Session ID");
  expect(deliveredOrder).toMatchObject({
    client_request_key: firstIdempotencyKey,
    status: "delivered",
    stripe_checkout_session_id: sessionId,
  });

  const recoveredIntent = await readPersistedIntent(
    context,
    stack.urls.frontend,
    seededUser.organizationId,
  );
  expect(recoveredIntent).toMatchObject({
    version: 1,
    organizationId: seededUser.organizationId,
    initiatedByUserId: seededUser.userId,
    amountCents: CHECKOUT_AMOUNT_CENTS,
    idempotencyKey: firstIdempotencyKey,
    sessionId,
  });

  const session = fakeStripe.state.sessions.get(sessionId);
  expect(session).toMatchObject({
    id: sessionId,
    url: navigation.url(),
    client_reference_id: deliveredOrder.id,
    amount_total: CHECKOUT_AMOUNT_CENTS,
    currency: "usd",
    metadata: {
      checkout_order_id: deliveredOrder.id,
      type: "custom_amount",
    },
  });
  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.counters.checkoutSessionsCreated).toBe(1);
  const providerCreatesAfterRecovery = fakeStripe.state.requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/v1/checkout/sessions",
  );
  expect(providerCreatesAfterRecovery).toHaveLength(
    providerCreatesAfterLoss.length,
  );
  const providerRecoveryReads = fakeStripe.state.requests.filter(
    (request) =>
      request.method === "GET" && request.path === "/v1/checkout/sessions",
  );
  expect(providerRecoveryReads).toHaveLength(1);

  await testInfo.attach("billing-checkout-response-loss-ui-receipt.json", {
    body: JSON.stringify(
      {
        browser: {
          responseStatuses: [firstResponse.status(), secondResponse.status()],
          requestIdempotencyKeys: [firstIdempotencyKey, secondIdempotencyKey],
          navigationUrl: navigation.url(),
        },
        ambiguous: {
          persistedIntent: ambiguousIntent,
          orderId: ambiguousOrder.id,
          orderStatus: ambiguousOrder.status,
          providerResponsesLost: lostProviderResponses,
        },
        recovered: {
          persistedIntent: recoveredIntent,
          orderId: deliveredOrder.id,
          orderStatus: deliveredOrder.status,
          checkoutSessionId: sessionId,
        },
        fakeStripe: {
          customersCreated: fakeStripe.state.counters.customersCreated,
          checkoutSessionsCreated:
            fakeStripe.state.counters.checkoutSessionsCreated,
          effectCount: fakeStripe.state.effects.length,
          providerSessionCreateRequests: providerCreatesAfterRecovery.length,
          providerRecoveryReads: providerRecoveryReads.length,
          providerIdempotencyKey: `checkout-order:${deliveredOrder.id}`,
        },
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  await Promise.allSettled([authenticatedPage.close()]);
});
