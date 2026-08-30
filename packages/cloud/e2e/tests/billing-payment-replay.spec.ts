/**
 * Adversarial card-payment replay through the real local Worker and PGlite.
 *
 * The only simulated boundary is a loopback Stripe-compatible provider. The
 * first Checkout creation commits at that provider and loses its response. The
 * Worker must leave durable ambiguity, recover the same Session on an
 * application retry, and settle one credit/ledger/invoice receipt from
 * duplicate signed webhooks.
 */

import { createHmac } from "node:crypto";
import { webhookEventsRepository } from "@elizaos/cloud-shared/db/repositories/webhook-events";
import { creditsService } from "@elizaos/cloud-shared/lib/services/credits";
import { invoicesService } from "@elizaos/cloud-shared/lib/services/invoices";
import { stripeCheckoutOrdersService } from "@elizaos/cloud-shared/lib/services/stripe-checkout-orders";
import {
  createCloudAgent,
  getPersistedAgentSummary,
} from "../src/helpers/provisioning";
import {
  buildPlaywrightSessionToken,
  expect,
  test,
} from "../src/helpers/test-fixtures";

const CHECKOUT_PATH = "/api/stripe/create-checkout-session";
const WEBHOOK_PATH = "/api/stripe/webhook";
const BILLING_PAGE_PATH = "/cloud/billing";
const BILLING_SNAPSHOT_PATH = "/api/v1/billing/limits";
const INVOICE_LIST_PATH = "/api/invoices/list";
const WEBHOOK_SECRET = "whsec_cloud_e2e";

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

interface BillingSnapshotResponse {
  success?: boolean;
  data?: {
    schemaVersion?: number;
    v2?: {
      balance?: unknown;
    };
  };
}

interface InvoiceListResponse {
  invoices?: Array<{
    id?: string;
    stripeInvoiceId?: string;
    total?: string;
    status?: string;
    type?: string;
    creditsAdded?: number;
  }>;
  count?: number;
}

test.use({
  stackOptions: {
    fakeStripe: true,
    backendFaults: true,
  },
});

test("lost provider response and duplicate webhook settle exactly once", async ({
  authenticatedPage,
  stack,
  seededUser,
}) => {
  test.setTimeout(240_000);
  const fakeStripe = stack.mocks.stripe;
  expect(fakeStripe, "fake Stripe must be booted for this lane").toBeDefined();
  if (!fakeStripe) throw new Error("fake Stripe was not booted");

  const startingBalance = await creditsService.getOrganizationBalanceUsd(
    seededUser.organizationId,
  );
  expect(startingBalance).toBe(1_000);
  const sessionToken = buildPlaywrightSessionToken(
    seededUser.userId,
    seededUser.organizationId,
  );

  const requestKey = "billing-replay-lost-response-0001";
  const createCheckout = () =>
    fetch(`${stack.urls.api}${CHECKOUT_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `eliza-test-session=${sessionToken}`,
        Origin: stack.urls.api,
        "X-Eliza-CSRF": "1",
        "Idempotency-Key": requestKey,
      },
      body: JSON.stringify({ amount: 5, returnUrl: "billing" }),
    });

  fakeStripe.loseNextCheckoutSessionCreateResponseAfterCommit();
  const lostResponse = await createCheckout();
  expect(lostResponse.status).toBe(500);

  expect(fakeStripe.state.customers.size).toBe(1);
  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.counters.checkoutSessionsCreated).toBe(1);
  const lostProviderResponses =
    fakeStripe.state.counters.checkoutSessionCreateResponsesLost;
  expect([1, 2]).toContain(lostProviderResponses);

  const session = [...fakeStripe.state.sessions.values()][0];
  expect(
    session,
    "provider effect must retain the committed Session",
  ).toBeDefined();
  if (!session) throw new Error("fake Stripe committed no Checkout Session");
  const checkoutOrderId = session.metadata.checkout_order_id;
  expect(checkoutOrderId).toBeTruthy();

  const ambiguousOrder = await stripeCheckoutOrdersService.get(checkoutOrderId);
  expect(ambiguousOrder).toMatchObject({
    id: checkoutOrderId,
    organization_id: seededUser.organizationId,
    initiated_by_user_id: seededUser.userId,
    status: "provider_ambiguous",
    stripe_customer_id: session.customer,
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    credit_transaction_id: null,
  });
  expect(ambiguousOrder?.credits_to_grant).toBe("5.000000");
  expect(ambiguousOrder?.charge_amount_cents).toBe(500n);

  const providerCreatesAfterLoss = fakeStripe.state.requests.filter(
    (request) =>
      request.method === "POST" && request.path === "/v1/checkout/sessions",
  );
  expect(providerCreatesAfterLoss).toHaveLength(lostProviderResponses);
  expect(
    providerCreatesAfterLoss.every(
      (request) =>
        request.headers["idempotency-key"] ===
        `checkout-order:${checkoutOrderId}`,
    ),
  ).toBe(true);
  expect(
    providerCreatesAfterLoss.every(
      (request) => request.headers["stripe-version"] === "2024-11-20.acacia",
    ),
  ).toBe(true);

  const recoveredResponse = await createCheckout();
  expect(recoveredResponse.status).toBe(200);
  const recovered = (await recoveredResponse.json()) as {
    sessionId?: string;
    url?: string;
  };
  expect(recovered).toEqual({ sessionId: session.id, url: session.url });

  const deliveredOrder = await stripeCheckoutOrdersService.get(checkoutOrderId);
  expect(deliveredOrder).toMatchObject({
    status: "delivered",
    stripe_customer_id: session.customer,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: null,
    credit_transaction_id: null,
  });
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.counters.checkoutSessionCreateAttempts).toBe(
    lostProviderResponses,
  );
  expect(
    fakeStripe.state.requests.filter(
      (request) =>
        request.method === "GET" && request.path === "/v1/checkout/sessions",
    ),
  ).toHaveLength(1);
  expect(
    await creditsService.getOrganizationBalanceUsd(seededUser.organizationId),
  ).toBe(startingBalance);

  const completedSession = fakeStripe.completeCheckoutSession(session.id);
  expect(completedSession).toMatchObject({
    payment_status: "paid",
    status: "complete",
  });
  expect(completedSession.payment_intent).toBeTruthy();
  const eventId = "evt_cloud_e2e_checkout_completed_0001";
  const signWebhook = (signedEventId: string) => {
    const timestamp = Math.floor(Date.now() / 1_000);
    const rawEvent = JSON.stringify({
      id: signedEventId,
      object: "event",
      api_version: "2024-11-20.acacia",
      created: timestamp,
      data: { object: completedSession },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "checkout.session.completed",
    });
    return {
      eventId: signedEventId,
      rawEvent,
      signature: createHmac("sha256", WEBHOOK_SECRET)
        .update(`${timestamp}.${rawEvent}`)
        .digest("hex"),
      timestamp,
    };
  };
  const deliverWebhook = (signedEvent: ReturnType<typeof signWebhook>) =>
    fetch(`${stack.urls.api}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": `t=${signedEvent.timestamp},v1=${signedEvent.signature}`,
      },
      body: signedEvent.rawEvent,
    });
  const drainStripeQueue = async () => {
    const response = await fetch(
      `${stack.urls.api}/api/cron/process-stripe-queue`,
      {
        method: "POST",
        headers: { Authorization: "Bearer test-cron-secret" },
      },
    );
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  };

  const originalSignedEvent = signWebhook(eventId);
  const firstWebhook = await deliverWebhook(originalSignedEvent);
  expect(firstWebhook.status).toBe(200);
  expect(await firstWebhook.json()).toEqual({ received: true, queued: true });

  const duplicateWebhook = await deliverWebhook(originalSignedEvent);
  expect(duplicateWebhook.status).toBe(200);
  expect(await duplicateWebhook.json()).toEqual({
    received: true,
    duplicate: true,
  });
  expect(await webhookEventsRepository.findByEventId(eventId)).toMatchObject({
    event_id: eventId,
    provider: "stripe",
    event_type: "checkout.session.completed",
  });

  const drain = await drainStripeQueue();
  expect(drain).toMatchObject({
    success: true,
    queue: "stripe-events",
    before: 1,
    after: 0,
    attempted: 1,
    acked: 1,
    retried: 0,
    dlqed: 0,
    failed: 0,
  });

  const settledOrder = await stripeCheckoutOrdersService.get(checkoutOrderId);
  expect(
    settledOrder,
    "Checkout order must exist after settlement",
  ).toBeDefined();
  if (!settledOrder) throw new Error("settled Checkout order was not found");
  expect(settledOrder).toMatchObject({
    status: "settled",
    stripe_customer_id: session.customer,
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: completedSession.payment_intent,
  });
  expect(settledOrder.credit_transaction_id).toBeTruthy();
  expect(settledOrder.settled_at).toBeInstanceOf(Date);

  const matchingTransactions = (
    await creditsService.listTransactionsByOrganization(
      seededUser.organizationId,
      100,
    )
  ).filter(
    (transaction) =>
      transaction.stripe_payment_intent_id === completedSession.payment_intent,
  );
  expect(matchingTransactions).toHaveLength(1);
  expect(matchingTransactions[0]).toMatchObject({
    id: settledOrder.credit_transaction_id,
    organization_id: seededUser.organizationId,
    amount: "5.000000",
    type: "credit",
  });

  const matchingInvoices = (
    await invoicesService.listByOrganization(seededUser.organizationId)
  ).filter((invoice) => invoice.stripe_invoice_id === `cs_${session.id}`);
  expect(matchingInvoices).toHaveLength(1);
  expect(matchingInvoices[0]).toMatchObject({
    organization_id: seededUser.organizationId,
    stripe_customer_id: session.customer,
    stripe_payment_intent_id: completedSession.payment_intent,
    amount_paid: "5.00",
    status: "paid",
    invoice_type: "custom_amount",
  });
  expect(
    await creditsService.getOrganizationBalanceUsd(seededUser.organizationId),
  ).toBe(startingBalance + 5);

  const settlementIdentity = {
    orderId: settledOrder.id,
    checkoutSessionId: settledOrder.stripe_checkout_session_id,
    paymentIntentId: settledOrder.stripe_payment_intent_id,
    creditTransactionId: settledOrder.credit_transaction_id,
    settledAt: settledOrder.settled_at?.toISOString(),
    transactionId: matchingTransactions[0]?.id,
    invoiceId: matchingInvoices[0]?.id,
  };
  expect(settlementIdentity).toMatchObject({
    orderId: checkoutOrderId,
    checkoutSessionId: session.id,
    paymentIntentId: completedSession.payment_intent,
    creditTransactionId: expect.any(String),
    settledAt: expect.any(String),
    transactionId: expect.any(String),
    invoiceId: expect.any(String),
  });

  // Stripe retries the exact already-settled event: durable event-id dedupe
  // acknowledges it without enqueueing any second consumer delivery.
  const postSettlementExactReplay = await deliverWebhook(originalSignedEvent);
  expect(postSettlementExactReplay.status).toBe(200);
  expect(await postSettlementExactReplay.json()).toEqual({
    received: true,
    duplicate: true,
  });
  expect(await drainStripeQueue()).toEqual({
    success: true,
    queue: "stripe-events",
    before: 0,
    after: 0,
    attempted: 0,
    acked: 0,
    retried: 0,
    dlqed: 0,
    failed: 0,
  });

  // A distinct Stripe event id can legitimately carry the same Session and
  // PaymentIntent. It must enter the queue, then hit settlement-level dedupe.
  const replayEventId = "evt_cloud_e2e_checkout_completed_0002";
  const newSignedEvent = signWebhook(replayEventId);
  expect(newSignedEvent.signature).not.toBe(originalSignedEvent.signature);
  const newEventReplay = await deliverWebhook(newSignedEvent);
  expect(newEventReplay.status).toBe(200);
  expect(await newEventReplay.json()).toEqual({ received: true, queued: true });
  expect(
    await webhookEventsRepository.findByEventId(replayEventId),
  ).toMatchObject({
    event_id: replayEventId,
    provider: "stripe",
    event_type: "checkout.session.completed",
  });
  expect(await drainStripeQueue()).toEqual({
    success: true,
    queue: "stripe-events",
    before: 1,
    after: 0,
    attempted: 1,
    acked: 1,
    retried: 0,
    dlqed: 0,
    failed: 0,
  });

  const replayedOrder = await stripeCheckoutOrdersService.get(checkoutOrderId);
  expect(replayedOrder).toMatchObject({
    id: settlementIdentity.orderId,
    status: "settled",
    stripe_checkout_session_id: settlementIdentity.checkoutSessionId,
    stripe_payment_intent_id: settlementIdentity.paymentIntentId,
    credit_transaction_id: settlementIdentity.creditTransactionId,
  });
  expect(replayedOrder?.settled_at).toBeInstanceOf(Date);
  expect(replayedOrder?.settled_at?.toISOString()).toBe(
    settlementIdentity.settledAt,
  );

  const transactionsAfterReplay = (
    await creditsService.listTransactionsByOrganization(
      seededUser.organizationId,
      100,
    )
  ).filter(
    (transaction) =>
      transaction.stripe_payment_intent_id === completedSession.payment_intent,
  );
  expect(transactionsAfterReplay).toHaveLength(1);
  expect(transactionsAfterReplay[0]?.id).toBe(settlementIdentity.transactionId);

  const invoicesAfterReplay = (
    await invoicesService.listByOrganization(seededUser.organizationId)
  ).filter((invoice) => invoice.stripe_invoice_id === `cs_${session.id}`);
  expect(invoicesAfterReplay).toHaveLength(1);
  expect(invoicesAfterReplay[0]?.id).toBe(settlementIdentity.invoiceId);

  expect(
    await creditsService.getOrganizationBalanceUsd(seededUser.organizationId),
  ).toBe(startingBalance + 5);

  const invoiceId = settlementIdentity.invoiceId;
  expect(invoiceId).toEqual(expect.any(String));
  if (typeof invoiceId !== "string") {
    throw new Error("settled invoice identity was not retained after replay");
  }

  const backendFaults = stack.mocks.backendFaults;
  expect(
    backendFaults,
    "the real app shell requires the server-side path-rewrite controller",
  ).toBeDefined();
  if (!backendFaults) throw new Error("backend fault controller unavailable");
  backendFaults.clearFault();

  try {
    const agentId = await createCloudAgent(
      { apiUrl: stack.urls.api },
      seededUser.apiKey,
      `billing-replay-projection-e2e-${Date.now().toString(36)}`,
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
      ({ runtimeAgentId, apiBase, apiKey }) => {
        window.localStorage.setItem("eliza:first-run-complete", "1");
        window.localStorage.setItem(
          "elizaos:active-server",
          JSON.stringify({
            id: `cloud:${runtimeAgentId}`,
            kind: "cloud",
            label: "Billing replay projection E2E shared runtime",
            apiBase,
            accessToken: apiKey,
            cloudRuntimeAgentId: runtimeAgentId,
            cloudRuntime: "shared",
          }),
        );
      },
      {
        runtimeAgentId: agentId,
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

    const snapshotResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === BILLING_SNAPSHOT_PATH &&
        response.status() === 200,
      { timeout: 60_000 },
    );
    const invoiceResponsePromise = authenticatedPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === INVOICE_LIST_PATH &&
        response.status() === 200,
      { timeout: 60_000 },
    );
    await authenticatedPage.goto(`${stack.urls.frontend}${BILLING_PAGE_PATH}`, {
      timeout: 60_000,
    });
    const [snapshotResponse, invoiceResponse] = await Promise.all([
      snapshotResponsePromise,
      invoiceResponsePromise,
    ]);

    const snapshotBody =
      (await snapshotResponse.json()) as BillingSnapshotResponse;
    expect(snapshotBody.success).toBe(true);
    expect(snapshotBody.data?.schemaVersion).toBe(2);
    expect(snapshotBody.data?.v2?.balance).toMatchObject({
      status: "available",
      source: "organizations",
      value: {
        balance: {
          value: "1005.000000",
          unit: "usd",
          currency: "USD",
        },
      },
    });

    const invoiceBody = (await invoiceResponse.json()) as InvoiceListResponse;
    expect(invoiceBody.count).toBe(1);
    expect(invoiceBody.invoices).toHaveLength(1);
    expect(invoiceBody.invoices?.[0]).toMatchObject({
      id: invoiceId,
      stripeInvoiceId: `cs_${session.id}`,
      total: "$5.00",
      status: "Paid",
      type: "custom_amount",
      creditsAdded: 5,
    });

    const renderedBalance = authenticatedPage.getByText("$1,005.00", {
      exact: true,
    });
    await expect(renderedBalance).toHaveCount(1);
    await expect(renderedBalance).toBeVisible();

    const invoiceRow = authenticatedPage.getByTestId("invoice-row");
    await expect(invoiceRow).toHaveCount(1);
    await expect(invoiceRow.getByText("$5.00", { exact: true })).toBeVisible();
    await expect(invoiceRow.getByText("Paid", { exact: true })).toBeVisible();
    // The response above owns the durable invoice identity; this slice only
    // proves its single list projection. Navigation and invoice detail are a
    // separate contract, so the existing View control is intentionally not clicked.
    await expect(
      invoiceRow.getByRole("button", { name: "View", exact: true }),
    ).toBeVisible();
  } finally {
    backendFaults.clearFault();
    backendFaults.clearPathRewrites();
  }

  expect(fakeStripe.state.sessions.size).toBe(1);
  expect(fakeStripe.state.sessions.get(session.id)?.id).toBe(session.id);
  expect(fakeStripe.state.effects).toHaveLength(1);
  expect(fakeStripe.state.counters.checkoutSessionsCreated).toBe(1);
});
