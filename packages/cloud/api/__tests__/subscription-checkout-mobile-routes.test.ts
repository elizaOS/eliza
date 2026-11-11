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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createServer } from "node:http";
import type { CurrentBillingManagerCredential } from "@elizaos/cloud-shared/auth";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import {
  MobileAppAuthProtocolError,
  type MobileAppAuthRegistration,
} from "@elizaos/cloud-shared/lib/services/mobile-app-auth";
import type { EntitlementPlanSummary } from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { ElizaError } from "@elizaos/core";
import type { SubscriptionCheckoutConfirmRouteDependencies } from "../v1/subscriptions/checkout/confirm/route";
import type { SubscriptionCheckoutRouteDependencies } from "../v1/subscriptions/checkout/route";

// The cross-organization test reads a session through the real Stripe SDK from
// a loopback provider; it must fail before any database or entitlement work.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.ENVIRONMENT = "local";
process.env.NODE_ENV = "test";
process.env.CLOUD_E2E = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_cloud_e2e";

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

  test("a client disabled or re-pointed while the request runs stops the checkout before the provider write", async () => {
    for (const later of [
      async (): Promise<MobileAppAuthRegistration> => {
        throw new MobileAppAuthProtocolError("invalid_client", "disabled");
      },
      async (): Promise<MobileAppAuthRegistration> => ({
        ...REGISTRATION,
        redirectUri: "https://eliza.app/other/auth/callback",
      }),
    ]) {
      let resolutions = 0;
      let providerWrites = 0;
      const { deps } = checkoutDeps(MOBILE, {
        resolveRegistration: async () => {
          resolutions += 1;
          return resolutions === 1 ? REGISTRATION : await later();
        },
        submit: async (_input, reauthorize) => {
          await reauthorize();
          providerWrites += 1;
          throw new Error("unreachable: the provider write was authorized");
        },
      });
      const res = await post(createSubscriptionCheckoutRoute(deps), {
        planKey: "plus_monthly",
        idempotencyKey: KEY,
        presentation: "mobile",
      });
      expect([401, 403]).toContain(res.status);
      expect(resolutions).toBe(2);
      expect(providerWrites).toBe(0);
    }
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
  const resolved: string[] = [];
  const deps: SubscriptionCheckoutConfirmRouteDependencies = {
    authorize: async () => caller,
    resolveRegistration: async (_env, credential) => {
      resolved.push(credential.id);
      return REGISTRATION;
    },
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
  return { deps, reconciled, resolved };
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

  test("an unpaid session is retryable", async () => {
    const { deps } = confirmDeps(MOBILE, {
      reconcile: async () => {
        throw new ElizaError("checkout", {
          code: "SUBSCRIPTION_CHECKOUT_UNAVAILABLE",
          context: { reason: "checkout_payment_pending" },
        });
      },
    });
    const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
      sessionId: "cs_test_unpaid",
    });
    expect(res.status).toBe(503);
    expect((await bodyOf(res)).code).toBe("service_unavailable");
  });

  test("a mobile credential confirms only while its client is still registered; a session never resolves one", async () => {
    const mobile = confirmDeps(MOBILE);
    await post(createSubscriptionCheckoutConfirmRoute(mobile.deps), {
      sessionId: "cs_test_1",
    });
    expect(mobile.resolved).toEqual([CREDENTIAL.id]);
    const session = confirmDeps(SESSION);
    await post(createSubscriptionCheckoutConfirmRoute(session.deps), {
      sessionId: "cs_test_1",
    });
    expect(session.resolved).toEqual([]);
    expect(session.reconciled).toHaveLength(1);

    for (const [code, status, apiCode] of [
      ["invalid_client", 401, "authentication_required"],
      ["server_configuration_error", 503, "service_unavailable"],
    ] as const) {
      const { deps, reconciled } = confirmDeps(MOBILE, {
        resolveRegistration: async () => {
          throw new MobileAppAuthProtocolError(code, "registration");
        },
      });
      const res = await post(createSubscriptionCheckoutConfirmRoute(deps), {
        sessionId: "cs_test_1",
      });
      expect(res.status).toBe(status);
      expect((await bodyOf(res)).code).toBe(apiCode);
      expect(reconciled).toEqual([]);
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

describe("checkout/confirm with a mobile caller and the real organization check", () => {
  const OWNER_ORGANIZATION = "82000000-0000-4000-8000-0000000000aa";
  const SESSION_ID = "cs_test_ownedByAnotherOrganization";
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    if (
      request.method === "GET" &&
      request.url === `/v1/checkout/sessions/${SESSION_ID}`
    )
      return response.end(
        JSON.stringify({
          id: SESSION_ID,
          object: "checkout.session",
          mode: "subscription",
          status: "complete",
          payment_status: "paid",
          customer: "cus_owner",
          subscription: "sub_owner",
          invoice: "in_owner",
          livemode: false,
          client_reference_id: "87000000-0000-4000-8000-0000000000aa",
          metadata: {
            app: "eliza-cloud",
            organization_id: OWNER_ORGANIZATION,
            command_id: "87000000-0000-4000-8000-0000000000aa",
          },
        }),
      );
    response.writeHead(404);
    response.end(
      JSON.stringify({ error: { message: "Unexpected provider request" } }),
    );
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Loopback address missing");
    process.env.STRIPE_CLOUD_E2E_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("a paid session of another organization is refused after reading only that session", async () => {
    // Only authentication and the registry are injected: the route's own
    // reconcile compares the provider session's organization with the caller's.
    const { reconcileSubscriptionCheckout } = await import(
      "@elizaos/cloud-shared/lib/services/subscription-checkout"
    );
    let summaries = 0;
    const res = await post(
      createSubscriptionCheckoutConfirmRoute({
        authorize: async () => MOBILE,
        resolveRegistration: async () => REGISTRATION,
        reconcile: reconcileSubscriptionCheckout,
        summary: async () => {
          summaries += 1;
          return SUMMARY;
        },
      }),
      { sessionId: SESSION_ID },
    );
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({
      success: false,
      code: "billing_state_conflict",
    });
    expect(requests).toEqual([`GET /v1/checkout/sessions/${SESSION_ID}`]);
    expect(summaries).toBe(0);
  });
});
