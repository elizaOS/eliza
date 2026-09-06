/** Supplies a deterministic HTTP boundary for billing stories and UI tests; it is not provider or database evidence. */

import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  type AppBillingCatalog,
  AppBillingClient,
  type AppBillingOperation,
  type AppBillingSnapshot,
  type AppBillingUpdateQuote,
} from "@elizaos/cloud-sdk/app-billing";

export function billingFixture(
  options: {
    appId?: string;
    appName?: string;
    environment?: "test" | "live";
  } = {},
) {
  const appId = options.appId ?? "app-a";
  const environment = options.environment ?? "test";
  const catalog: AppBillingCatalog = {
    appId,
    appName: options.appName ?? "Field Notes",
    environment,
    plans: [
      {
        id: "plan-1",
        appId,
        name: "Team",
        planKey: "team",
        productFamilyKey: "workspace",
        revision: "1",
        amountCents: 1800,
        currency: "usd",
        interval: "month",
        intervalCount: 1,
        seats: { minimum: 1, maximum: 20 },
        trial: { days: 7, paymentMethodRequired: false, allowanceUsd: "2.00" },
        allowanceUsd: "10.00",
        featureKeys: ["Shared workspace", "AI research"],
        expiredAccess: "read_only",
      },
    ],
  };
  let snapshot: AppBillingSnapshot = {
    account: {
      id: "account-1",
      appId,
      displayName: "Personal account",
      externalReference: null,
      role: "administrator",
    },
    environment,
    productFamilyKey: "workspace",
    observedAt: "2026-09-05T12:00:00Z",
    mutationRevision: null,
    pendingOperation: null,
    subscription: null,
    entitlement: null,
    allowances: [],
    trialEligibility: { status: "eligible" },
  };
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let nextOperation: AppBillingOperation = {
    id: "operation-1",
    appId,
    environment,
    billingAccountId: "account-1",
    productFamilyKey: "workspace",
    status: "succeeded",
    subscriptionRevision: "1",
  };
  let failure: "none" | "read" | "uncertain" | "authority" | "not_applied" =
    "none";
  const quote: AppBillingUpdateQuote = {
    id: "quote-1",
    appId,
    billingAccountId: "account-1",
    productFamilyKey: "workspace",
    planRevisionId: "plan-1",
    quantity: 1,
    subscriptionRevision: "4",
    dueNowCents: 900,
    recurringAmountCents: 1800,
    nextInvoiceAmountCents: 1800,
    currency: "usd",
    trialEndsAt: "2027-09-12T12:00:00Z",
    expiresAt: "2099-09-05T12:10:00Z",
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const body =
      request.method === "GET"
        ? null
        : ((await request.json()) as Record<string, unknown>);
    calls.push({ path, body, method: request.method });
    if (failure === "read" && request.method === "GET")
      return Response.json(
        { error: "Billing database unavailable" },
        { status: 503 },
      );
    if (
      (failure === "authority" || failure === "not_applied") &&
      request.method === "POST" &&
      !path.endsWith("/accounts")
    )
      return Response.json(
        {
          error: "Subscription request rejected",
          code:
            failure === "authority"
              ? "APP_BILLING_AUTHORITY_CONFLICT"
              : "APP_BILLING_COMMAND_NOT_APPLIED",
        },
        { status: 409 },
      );
    const data = path.endsWith("/catalog")
      ? catalog
      : path.endsWith("/accounts")
        ? snapshot.account
        : path.endsWith("/workspace")
          ? snapshot
          : path.endsWith("/quote")
            ? { ...quote, quantity: body?.quantity }
            : /\/(seats|invoices|usage)$/.test(path)
              ? { items: [], nextCursor: null }
              : nextOperation;
    if (
      failure === "uncertain" &&
      request.method === "POST" &&
      !path.endsWith("/accounts")
    ) {
      failure = "none";
      throw new TypeError("Connection interrupted after request dispatch");
    }
    return Response.json({ success: true, data });
  };
  const client = new AppBillingClient(
    new CloudApiClient("https://fixture.example/api/v1", undefined, {
      fetchImpl,
    }),
    appId,
  );
  return {
    client,
    catalog,
    calls,
    quote,
    get snapshot() {
      return snapshot;
    },
    set snapshot(value: AppBillingSnapshot) {
      snapshot = value;
    },
    set operation(value: AppBillingOperation) {
      nextOperation = value;
    },
    set failure(value: typeof failure) {
      failure = value;
    },
  };
}
