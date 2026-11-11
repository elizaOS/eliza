/**
 * Route contracts for starting and confirming an organization subscription
 * checkout from a first-party mobile credential. The handlers and error
 * boundary are the real modules; the shared-Redis money limiter is passed
 * through, and authentication, the native client
 * registration and the provider-backed services are injected. Credential and
 * role rules are covered in cloud-shared (billing-manager-credential.test.ts),
 * the provider contract against a loopback Stripe in
 * subscription-checkout-recovery.pglite.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { CurrentBillingManagerCredential } from "@elizaos/cloud-shared/auth";
import {
  MobileAppAuthProtocolError,
  type MobileAppAuthRegistration,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { EntitlementPlanSummary } from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { ElizaError } from "@elizaos/core";
import type { SubscriptionCheckoutConfirmRouteDependencies } from "../v1/subscriptions/checkout/confirm/route";
import type { SubscriptionCheckoutRouteDependencies } from "../v1/subscriptions/checkout/route";

// The money limiter fails closed without shared Redis; it has its own suite.
const rateLimitModule = await import(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare"
);
mock.module(
  "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare",
  () => ({
    ...rateLimitModule,
    moneyRateLimit: () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
  }),
);
const { createSubscriptionCheckoutConfirmRoute } = await import(
  "../v1/subscriptions/checkout/confirm/route"
);
const { createSubscriptionCheckoutRoute } = await import(
  "../v1/subscriptions/checkout/route"
);

const USER = {
  id: "81000000-0000-4000-8000-000000000001",
  organization_id: "82000000-0000-4000-8000-000000000001",
  role: "owner",
} as CurrentBillingManagerCredential["user"];
const CREDENTIAL = {
  id: "85000000-0000-4000-8000-000000000001",
  user_id: USER.id,
  organization_id: USER.organization_id,
  source_app_id: "86000000-0000-4000-8000-000000000001",
} as NonNullable<CurrentBillingManagerCredential["mobileCredential"]>;
const MOBILE: CurrentBillingManagerCredential = {
  user: USER,
  mobileCredential: CREDENTIAL,
};
const SESSION: CurrentBillingManagerCredential = {
  user: USER,
  mobileCredential: null,
};
const REGISTRATION: MobileAppAuthRegistration = {
  appId: "86000000-0000-4000-8000-000000000001",
  clientId: "ai.alphacompute.alphaphone",
  environment: "production",
  redirectUri: "https://eliza.app/alphaphone/auth/callback",
  scopes: ["cloud:user"],
  credentialTtlSeconds: 2_592_000,
};
const KEY = "0b9f5c0e-3a57-4c55-9d0e-1f2f6f1f0a01";
const SUMMARY: EntitlementPlanSummary = {
  plan: { id: "plus_monthly", name: "Plus", status: "active" },
  source: "subscription",
  effectiveUntil: new Date("2026-12-11T00:00:00Z"),
};
const ENV = { NODE_ENV: "test" };

let ipCounter = 0;
beforeEach(() => {
  ipCounter += 1;
});

function post(
  app: {
    request: ReturnType<typeof createSubscriptionCheckoutRoute>["request"];
  },
  body: unknown,
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `198.51.100.${ipCounter}`,
      },
      body: JSON.stringify(body),
    },
    ENV,
  );
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function checkoutDeps(
  caller: CurrentBillingManagerCredential,
  overrides: Partial<SubscriptionCheckoutRouteDependencies> = {},
) {
  const submitted: Parameters<
    SubscriptionCheckoutRouteDependencies["submit"]
  >[0][] = [];
  const deps: SubscriptionCheckoutRouteDependencies = {
    authorize: async () => caller,
    resolveRegistration: async () => REGISTRATION,
    submit: async (input, reauthorize) => {
      submitted.push(input);
      await reauthorize();
      return {
        status: "open",
        presentation: "mobile",
        commandId: "87000000-0000-4000-8000-000000000001",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
        sessionId: "cs_test_1",
        expiresAt: "2026-11-12T00:00:00.000Z",
      };
    },
    ...overrides,
  };
  return { deps, submitted };
}

describe("POST /api/v1/subscriptions/checkout with a mobile credential", () => {
  test("derives the return from the credential's registered client, never the request", async () => {
    const { deps, submitted } = checkoutDeps(MOBILE);
    const res = await post(createSubscriptionCheckoutRoute(deps), {
      planKey: "plus_monthly",
      idempotencyKey: KEY,
      presentation: "mobile",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({
      success: true,
      data: {
        status: "open",
        presentation: "mobile",
        commandId: "87000000-0000-4000-8000-000000000001",
        checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_1",
        sessionId: "cs_test_1",
        expiresAt: "2026-11-12T00:00:00.000Z",
      },
    });
    expect(submitted).toEqual([
      {
        planKey: "plus_monthly",
        idempotencyKey: KEY,
        presentation: "mobile",
        organizationId: USER.organization_id,
        actorId: USER.id,
        mobileReturnUrl: "https://eliza.app/alphaphone/billing/return",
      },
    ]);
  });

  test("refuses a client-supplied return address", async () => {
    const { deps, submitted } = checkoutDeps(MOBILE);
    for (const extra of [
      { returnUrl: "https://evil.example/return" },
      { successUrl: "https://evil.example/return" },
      { returnTo: "https://evil.example/return" },
    ]) {
      const res = await post(createSubscriptionCheckoutRoute(deps), {
        planKey: "plus_monthly",
        idempotencyKey: KEY,
        presentation: "mobile",
        ...extra,
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    }
    expect(submitted).toEqual([]);
  });

  test("a mobile credential cannot use another presentation, and a session cannot use mobile", async () => {
    const mobile = checkoutDeps(MOBILE);
    for (const presentation of [undefined, "hosted", "embedded", "shared"]) {
      const res = await post(createSubscriptionCheckoutRoute(mobile.deps), {
        planKey: "plus_monthly",
        idempotencyKey: KEY,
        ...(presentation ? { presentation } : {}),
      });
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).code).toBe("validation_error");
    }
    const session = checkoutDeps(SESSION);
    const res = await post(createSubscriptionCheckoutRoute(session.deps), {
      planKey: "plus_monthly",
      idempotencyKey: KEY,
      presentation: "mobile",
    });
    expect(res.status).toBe(400);
    expect(mobile.submitted).toEqual([]);
    expect(session.submitted).toEqual([]);
  });

  test("a browser session keeps its hosted checkout and never resolves a mobile client", async () => {
    let resolved = 0;
    const { deps, submitted } = checkoutDeps(SESSION, {
      resolveRegistration: async () => {
        resolved += 1;
        return REGISTRATION;
      },
    });
    const res = await post(createSubscriptionCheckoutRoute(deps), {
      planKey: "pro_monthly",
      idempotencyKey: KEY,
    });
    expect(res.status).toBe(200);
    expect(resolved).toBe(0);
    expect(submitted).toEqual([
      {
        planKey: "pro_monthly",
        idempotencyKey: KEY,
        organizationId: USER.organization_id,
        actorId: USER.id,
      },
    ]);
  });

  test("a credential whose client was disabled must sign in again; a broken registration is retryable", async () => {
    for (const [code, status, apiCode] of [
      ["invalid_client", 401, "authentication_required"],
      ["server_configuration_error", 503, "service_unavailable"],
    ] as const) {
      const { deps, submitted } = checkoutDeps(MOBILE, {
        resolveRegistration: async () => {
          throw new MobileAppAuthProtocolError(code, "registration");
        },
      });
      const res = await post(createSubscriptionCheckoutRoute(deps), {
        planKey: "plus_monthly",
        idempotencyKey: KEY,
        presentation: "mobile",
      });
      expect(res.status).toBe(status);
      expect((await bodyOf(res)).code).toBe(apiCode);
      expect(submitted).toEqual([]);
    }
    // A registered callback of another shape has no billing return.
    const { deps } = checkoutDeps(MOBILE, {
      resolveRegistration: async () => ({
        ...REGISTRATION,
        redirectUri: "https://eliza.app/alphaphone/signed-in",
      }),
    });
    const res = await post(createSubscriptionCheckoutRoute(deps), {
      planKey: "plus_monthly",
      idempotencyKey: KEY,
      presentation: "mobile",
    });
    expect(res.status).toBe(503);
  });

  test("a credential that changes before the provider write stops the checkout", async () => {
    let calls = 0;
    const { deps } = checkoutDeps(MOBILE, {
      authorize: async () => {
        calls += 1;
        return calls === 1
          ? MOBILE
          : {
              user: USER,
              mobileCredential: {
                ...CREDENTIAL,
                id: "85000000-0000-4000-8000-000000000002",
              },
            };
      },
    });
    const res = await post(createSubscriptionCheckoutRoute(deps), {
      planKey: "plus_monthly",
      idempotencyKey: KEY,
      presentation: "mobile",
    });
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).code).toBe("access_denied");
  });

  test("a member, or a credential that is not a manager's, is denied", async () => {
    const { deps, submitted } = checkoutDeps(MOBILE, {
      authorize: async () => {
        throw new ApiError(403, "access_denied", "not a manager");
      },
    });
    const res = await post(createSubscriptionCheckoutRoute(deps), {
      planKey: "plus_monthly",
      idempotencyKey: KEY,
      presentation: "mobile",
    });
    expect(res.status).toBe(403);
    expect(submitted).toEqual([]);
  });
});

function confirmDeps(
  caller: CurrentBillingManagerCredential,
  overrides: Partial<SubscriptionCheckoutConfirmRouteDependencies> = {},
) {
  const reconciled: [string, string | undefined][] = [];
  const deps: SubscriptionCheckoutConfirmRouteDependencies = {
    authorize: async () => caller,
    reconcile: async (sessionId, organizationId) => {
      reconciled.push([sessionId, organizationId]);
      return {
        subscriptionId: "88000000-0000-4000-8000-000000000001",
        replayed: false,
      };
    },
    summary: async () => SUMMARY,
    ...overrides,
  };
  return { deps, reconciled };
}

describe("POST /api/v1/subscriptions/checkout/confirm", () => {
  test("settles the caller organization's session and returns the entitlement", async () => {
    for (const caller of [MOBILE, SESSION]) {
      const { deps, reconciled } = confirmDeps(caller);
      const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
        sessionId: "cs_live_a1B2c3",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await bodyOf(res)).toEqual({
        success: true,
        data: {
          subscriptionId: "88000000-0000-4000-8000-000000000001",
          replayed: false,
        },
        entitlement: {
          plan: { id: "plus_monthly", name: "Plus", status: "active" },
          source: "subscription",
          effectiveUntil: "2026-12-11T00:00:00.000Z",
        },
      });
      expect(reconciled).toEqual([["cs_live_a1B2c3", USER.organization_id]]);
    }
  });

  test("a session of another organization is a conflict, an unpaid one is retryable", async () => {
    for (const [code, reason, status, apiCode] of [
      [
        "SUBSCRIPTION_CHECKOUT_REJECTED",
        "checkout_account_mismatch",
        409,
        "billing_state_conflict",
      ],
      [
        "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
        "checkout_payment_pending",
        503,
        "service_unavailable",
      ],
    ] as const) {
      const { deps } = confirmDeps(MOBILE, {
        reconcile: async () => {
          throw new ElizaError("checkout", { code, context: { reason } });
        },
      });
      const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
        sessionId: "cs_test_other",
      });
      expect(res.status).toBe(status);
      expect((await bodyOf(res)).code).toBe(apiCode);
    }
  });

  test("a committed purchase is reported even when the entitlement read fails", async () => {
    const { deps } = confirmDeps(MOBILE, {
      summary: async () => {
        throw new Error("replica unavailable");
      },
    });
    const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
      sessionId: "cs_test_1",
    });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      success: true,
      entitlement: null,
    });
  });

  test("rejects a malformed session id before any provider read", async () => {
    const { deps, reconciled } = confirmDeps(MOBILE);
    const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
      sessionId: "../v1/customers",
    });
    expect(res.status).toBe(400);
    expect(reconciled).toEqual([]);
  });
});
