/** Provides deterministic SDK HTTP responses for developer UI tests and stories; no provider or database is simulated as end-to-end evidence. */
import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  AppBillingAdminClient,
  type AppBillingAdministration,
  type AppBillingAdminOperation,
  type AppBillingPaidPeriod,
} from "@elizaos/cloud-sdk/app-billing-admin";
import { notificationFixture } from "./app-notification-fixture";
export function catalogFixture(appId = "app-a") {
  const data: AppBillingAdministration = {
    appId,
    registrations: [
      { id: "client-test", environment: "test", active: true },
      { id: "client-live", environment: "live", active: true },
    ],
    operations: [],
    merchants: [
      {
        id: "merchant-test",
        environment: "test",
        kind: "connected",
        connectionStatus: "ready",
        enabled: true,
        capabilities: { charges: true, payouts: true, cardPayments: true },
        requirementsDue: [],
        verifiedAt: "2026-09-05T12:00:00Z",
        revision: "1",
      },
    ],
    plans: [
      {
        id: "plan-team",
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
        featureKeys: ["research"],
        expiredAccess: "read_only",
        merchantId: "merchant-test",
        environment: "test",
        state: "verified",
        providerVerifiedAt: "2026-09-05T12:00:00Z",
        rateLimits: {
          completionsRpm: 60,
          embeddingsRpm: 60,
          standardRpm: 120,
          strictRpm: 30,
        },
      },
    ],
  };
  const payments: AppBillingPaidPeriod[] = [];
  const notifications = notificationFixture();
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let failure: "none" | "read" | "uncertain" = "none";
  let result: AppBillingAdminOperation = {
    id: "command-1",
    status: "succeeded",
    merchant: null,
    plan: null,
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    const notificationRequest = request.clone();
    const body =
      request.method === "GET"
        ? null
        : ((await request.json()) as Record<string, unknown>);
    calls.push({ path, method: request.method, body });
    if (path.includes("/notifications")) {
      notifications.config = {
        ...notifications.config,
        appId,
        environment:
          new URL(request.url).searchParams.get("clientRegistrationId") ===
          "client-live"
            ? "live"
            : "test",
      };
      return notifications.fetchImpl(notificationRequest);
    }
    if (failure === "read" && request.method === "GET")
      return Response.json(
        { error: "Catalog database unavailable" },
        { status: 503 },
      );
    if (failure === "uncertain" && request.method === "POST") {
      failure = "none";
      throw new TypeError("Response lost after creation request was sent");
    }
    if (path.endsWith("/paid-periods")) {
      const clientRegistrationId = new URL(request.url).searchParams.get(
        "clientRegistrationId",
      );
      const environment =
        clientRegistrationId === "client-live" ? "live" : "test";
      return Response.json({
        success: true,
        data: {
          appId,
          clientRegistrationId,
          environment,
          items: environment === "test" ? payments : [],
          nextCursor: null,
        },
      });
    }
    if (path.endsWith("/refunds/preview"))
      return Response.json({
        success: true,
        data: {
          appId,
          clientRegistrationId: body?.clientRegistrationId,
          paidPeriodId: body?.paidPeriodId,
          environment: "test",
          amountPaidCents: 9000,
          amountAvailableCents: 8500,
          currency: "usd",
          accessPolicy: "preserve",
        },
      });
    return Response.json({
      success: true,
      data:
        request.method === "GET"
          ? data
          : path.endsWith("/disconnect")
            ? {
                merchant: data.merchants[0],
                activeSubscriptionCount: 4,
                existingBillingContinues: true,
              }
            : result,
    });
  };
  return {
    data,
    payments,
    calls,
    fetchImpl,
    client: new AppBillingAdminClient(
      new CloudApiClient("https://fixture.example/api/v1", undefined, {
        fetchImpl,
      }),
      appId,
    ),
    set failure(value: typeof failure) {
      failure = value;
    },
    set result(value: AppBillingAdminOperation) {
      result = value;
    },
  };
}
