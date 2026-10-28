/**
 * Route contracts for subscription grant redemption and the signed
 * entitlement. The handlers and rate limiters are the real modules; only
 * authentication and persistence are injected. Repository and signing
 * behavior is covered against PGlite and real keys in cloud-shared.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  SUBSCRIPTION_GRANT_ALREADY_GRANTED,
  SUBSCRIPTION_GRANT_CODE_INVALID,
  SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
} from "@elizaos/cloud-shared/db/repositories/subscription-grants";
import type { SubscriptionGrant } from "@elizaos/cloud-shared/db/schemas/subscription-grants";
import { AuthenticationError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import type { CompatibleRedis } from "@elizaos/cloud-shared/lib/cache/redis-factory";
import {
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  type EntitlementPlanSummary,
  EntitlementSigningUnavailableError,
} from "@elizaos/cloud-shared/lib/services/subscription-entitlement-token";
import { ElizaError } from "@elizaos/core";
import { Hono } from "hono";
import { isPublicPath } from "../src/middleware/auth";
import { createSubscriptionEntitlementRoute } from "../v1/subscription/entitlement/route";
import { createSubscriptionEntitlementKeysRoute } from "../v1/subscription/entitlement-keys/route";
import {
  createSubscriptionRedeemRoute,
  REDEEM_LIMIT_PER_CREDENTIAL,
  REDEEM_LIMIT_PER_IP,
  type SubscriptionRedeemRouteDependencies,
} from "../v1/subscription/redeem/route";

const USER = {
  id: "81000000-0000-4000-8000-000000000001",
  organization_id: "82000000-0000-4000-8000-000000000001",
};
const GRANT: SubscriptionGrant = {
  id: "83000000-0000-4000-8000-000000000001",
  organization_id: USER.organization_id,
  user_id: USER.id,
  code_id: "84000000-0000-4000-8000-000000000001",
  family: "alpha_phone",
  plan_key: "plus_monthly",
  catalog_version: "v1",
  idempotency_key: "phone-install-1",
  starts_at: new Date("2026-10-13T00:00:00Z"),
  ends_at: new Date("2027-04-14T00:00:00Z"),
  created_at: new Date("2026-10-13T00:00:00Z"),
  revoked_at: null,
  revoked_reason: null,
};
const SUMMARY: EntitlementPlanSummary = {
  plan: { id: "plus_monthly", name: "Plus", status: "active" },
  source: "grant",
  effectiveUntil: GRANT.ends_at,
};

/** Route bodies are JSON objects; the cast keeps assertions readable. */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

let ipCounter = 0;
let credentialCounter = 0;
/** Bindings without Redis: the routes' declared local fallback limiter applies. */
const ENV = { NODE_ENV: "test" };

function redeemDeps(
  overrides: Partial<SubscriptionRedeemRouteDependencies> = {},
): SubscriptionRedeemRouteDependencies & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    authenticate: async () => USER,
    pepper: () => "pepper-0123456789abcdef0123456789abcdef",
    redeem: async (input) => {
      calls.push(input);
      return { grant: GRANT, replayed: false };
    },
    summary: async () => SUMMARY,
    ...overrides,
  };
}

function post(
  app: ReturnType<typeof createSubscriptionRedeemRoute>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": `198.51.100.${ipCounter}`,
        authorization: `Bearer eliza_test_key_${credentialCounter}`,
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    ENV,
  );
}

beforeEach(() => {
  ipCounter += 1;
  credentialCounter += 1;
});

describe("POST /api/v1/subscription/redeem", () => {
  test("redeems for the caller's organization and returns the entitlement summary", async () => {
    const deps = redeemDeps();
    const res = await post(createSubscriptionRedeemRoute(deps), {
      code: "abcd-efgh-jkmn-pqrs",
      idempotencyKey: "phone-install-1",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({
      success: true,
      replayed: false,
      grant: {
        id: GRANT.id,
        planKey: "plus_monthly",
        startsAt: "2026-10-13T00:00:00.000Z",
        endsAt: "2027-04-14T00:00:00.000Z",
        revoked: false,
        paidPlanTakesPrecedence: false,
      },
      entitlement: {
        plan: { id: "plus_monthly", name: "Plus", status: "active" },
        source: "grant",
        effectiveUntil: "2027-04-14T00:00:00.000Z",
      },
    });
    expect(deps.calls).toHaveLength(1);
    const call = deps.calls[0] as {
      organizationId: string;
      codeHash: string;
      idempotencyKey: string;
    };
    expect(call.organizationId).toBe(USER.organization_id);
    expect(call.idempotencyKey).toBe("phone-install-1");
    // The code is never passed or stored in plaintext.
    expect(call.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("presentation differences in a code hash identically", async () => {
    const deps = redeemDeps();
    const app = createSubscriptionRedeemRoute(deps);
    await post(app, {
      code: "abcd-efgh-jkmn-pqrs",
      idempotencyKey: "phone-install-1",
    });
    await post(app, {
      code: " ABCD EFGH JKMN PQRS ",
      idempotencyKey: "phone-install-1",
    });
    const [first, second] = deps.calls as Array<{ codeHash: string }>;
    expect(first!.codeHash).toBe(second!.codeHash);
  });

  test("Crockford read aliases (O for 0, I and L for 1) hash as the minted code", async () => {
    const deps = redeemDeps();
    const app = createSubscriptionRedeemRoute(deps);
    await post(app, {
      code: "0011-ABCD-EFGH-JKMN",
      idempotencyKey: "phone-install-1",
    });
    await post(app, {
      code: "oOiL-abcd-efgh-jkmn",
      idempotencyKey: "phone-install-1",
    });
    const [minted, typed] = deps.calls as Array<{ codeHash: string }>;
    expect(typed!.codeHash).toBe(minted!.codeHash);
  });

  test("text shorter than a minted code is refused without a lookup", async () => {
    const deps = redeemDeps();
    const res = await post(createSubscriptionRedeemRoute(deps), {
      code: "ABCD-EFGH-JKMN",
      idempotencyKey: "phone-install-1",
    });
    expect(res.status).toBe(400);
    expect(await bodyOf(res)).toMatchObject({
      code: "invalid_subscription_code",
    });
    expect(deps.calls).toHaveLength(0);
  });

  test("a committed grant answers 200 even when the summary read fails", async () => {
    const res = await post(
      createSubscriptionRedeemRoute(
        redeemDeps({
          summary: async () => {
            throw new Error("replica unavailable");
          },
        }),
      ),
      { code: "ABCD-EFGH-JKMN-PQRS", idempotencyKey: "phone-install-1" },
    );
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      success: true,
      grant: { id: GRANT.id, revoked: false },
      entitlement: null,
    });
  });

  test("the credential limit has its own counter, not the shared STANDARD one", async () => {
    // Minimal in-memory Redis with the commands the limiter uses.
    const counts = new Map<string, number>();
    const ttls = new Map<string, number>();
    const redis = {
      pipeline() {
        const ops: Array<() => number> = [];
        const pipeline = {
          incr(key: string) {
            ops.push(() => {
              const next = (counts.get(key) ?? 0) + 1;
              counts.set(key, next);
              return next;
            });
            return pipeline;
          },
          pttl(key: string) {
            ops.push(() => ttls.get(key) ?? -1);
            return pipeline;
          },
          async exec() {
            return ops.map((op) => op());
          },
        };
        return pipeline;
      },
      async pexpire(key: string, ms: number) {
        ttls.set(key, ms);
        return 1;
      },
    } as unknown as CompatibleRedis;
    const rateLimitDeps = { buildRedisClient: () => redis };
    const standard = new Hono();
    standard.use(
      "*",
      rateLimit(RateLimitPresets.STANDARD, undefined, rateLimitDeps),
    );
    standard.get("/", (c) => c.json({ ok: true }));
    const authorization = `Bearer eliza_test_key_${credentialCounter}`;
    // The phone's sign-in calls several STANDARD routes with the same key first.
    for (let index = 0; index < REDEEM_LIMIT_PER_CREDENTIAL + 3; index += 1)
      expect(
        (await standard.request("/", { headers: { authorization } }, ENV))
          .status,
      ).toBe(200);
    const sharedKeys = [...counts.keys()];
    const deps = redeemDeps({ rateLimit: rateLimitDeps });
    const res = await post(createSubscriptionRedeemRoute(deps), {
      code: "ABCD-EFGH-JKMN-PQRS",
      idempotencyKey: "phone-install-1",
    });
    expect(res.status).toBe(200);
    // Redeem neither counted against nor re-armed the shared counter's window.
    for (const key of sharedKeys) {
      expect(counts.get(key)).toBe(REDEEM_LIMIT_PER_CREDENTIAL + 3);
      expect(ttls.get(key)).toBe(RateLimitPresets.STANDARD.windowMs);
    }
    expect(
      [...counts.keys()].filter((key) => key.includes("subscription-redeem")),
    ).toHaveLength(2);
  });

  test("a replay returns the original grant", async () => {
    const res = await post(
      createSubscriptionRedeemRoute(
        redeemDeps({ redeem: async () => ({ grant: GRANT, replayed: true }) }),
      ),
      { code: "ABCD-EFGH-JKMN-PQRS", idempotencyKey: "phone-install-1" },
    );
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toMatchObject({
      replayed: true,
      grant: { id: GRANT.id },
    });
  });

  test("unknown, expired, disabled, exhausted and malformed codes share one refusal", async () => {
    const invalid = new ElizaError("Subscription code is not valid", {
      code: SUBSCRIPTION_GRANT_CODE_INVALID,
    });
    const deps = redeemDeps({
      redeem: async () => {
        throw invalid;
      },
    });
    const unknown = await post(createSubscriptionRedeemRoute(deps), {
      code: "ABCD-EFGH-JKMN-PQRS",
      idempotencyKey: "phone-install-1",
    });
    credentialCounter += 1;
    const malformed = await post(createSubscriptionRedeemRoute(deps), {
      code: "!!",
      idempotencyKey: "phone-install-1",
    });
    expect(unknown.status).toBe(400);
    expect(malformed.status).toBe(400);
    const body = await bodyOf(unknown);
    expect(body).toEqual({
      success: false,
      error: "This subscription code cannot be redeemed.",
      code: "invalid_subscription_code",
    });
    expect(await bodyOf(malformed)).toEqual(body);
  });

  test("a second code of the same family is a conflict", async () => {
    const res = await post(
      createSubscriptionRedeemRoute(
        redeemDeps({
          redeem: async () => {
            throw new ElizaError("already", {
              code: SUBSCRIPTION_GRANT_ALREADY_GRANTED,
            });
          },
        }),
      ),
      { code: "ABCD-EFGH-JKMN-PQRS", idempotencyKey: "phone-install-1" },
    );
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toMatchObject({
      code: "subscription_grant_already_redeemed",
    });
  });

  test("an exclusive code offered to a paying account is a distinct conflict", async () => {
    const res = await post(
      createSubscriptionRedeemRoute(
        redeemDeps({
          redeem: async () => {
            throw new ElizaError("paid", {
              code: SUBSCRIPTION_GRANT_PAID_PLAN_ACTIVE,
            });
          },
        }),
      ),
      { code: "ABCD-EFGH-JKMN-PQRS", idempotencyKey: "pilot-install-1" },
    );
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({
      success: false,
      error:
        "This account already has a paid plan. This subscription code cannot be added to it.",
      code: "subscription_grant_paid_plan_active",
    });
  });

  test("rejects a missing or invalid credential before reading the body", async () => {
    const deps = redeemDeps({
      authenticate: async () => {
        throw AuthenticationError("Invalid or expired API key");
      },
    });
    const res = await post(createSubscriptionRedeemRoute(deps), {
      code: "x",
      idempotencyKey: "y",
    });
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toMatchObject({
      code: "authentication_required",
    });
    expect(deps.calls).toHaveLength(0);
  });

  test("requires both code and a well-formed idempotency key", async () => {
    const app = createSubscriptionRedeemRoute(redeemDeps());
    for (const body of [
      { code: "ABCD-EFGH-JKMN-PQRS" },
      { code: "ABCD-EFGH-JKMN-PQRS", idempotencyKey: "short" },
      { idempotencyKey: "phone-install-1" },
      "not json",
    ]) {
      credentialCounter += 1;
      expect((await post(app, body)).status).toBe(400);
    }
  });

  test("fails closed while the code pepper is not configured", async () => {
    const res = await post(
      createSubscriptionRedeemRoute(redeemDeps({ pepper: () => undefined })),
      {
        code: "ABCD-EFGH-JKMN-PQRS",
        idempotencyKey: "phone-install-1",
      },
    );
    expect(res.status).toBe(503);
  });

  test("limits guesses per credential", async () => {
    const deps = redeemDeps();
    const app = createSubscriptionRedeemRoute(deps);
    const statuses: number[] = [];
    for (
      let attempt = 0;
      attempt <= REDEEM_LIMIT_PER_CREDENTIAL;
      attempt += 1
    ) {
      ipCounter += 1; // a rotating IP does not reset the credential limit
      statuses.push(
        (
          await post(app, {
            code: "ABCD-EFGH-JKMN-PQRS",
            idempotencyKey: "phone-install-1",
          })
        ).status,
      );
    }
    expect(
      statuses
        .slice(0, REDEEM_LIMIT_PER_CREDENTIAL)
        .every((status) => status === 200),
    ).toBe(true);
    const limited = await post(app, {
      code: "ABCD-EFGH-JKMN-PQRS",
      idempotencyKey: "phone-install-1",
    });
    expect(statuses.at(-1)).toBe(429);
    expect(limited.status).toBe(429);
    const body = await bodyOf(limited);
    expect(body.code).toBe("rate_limit_exceeded");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(deps.calls).toHaveLength(REDEEM_LIMIT_PER_CREDENTIAL);
  });

  test("limits guesses per IP across credentials", async () => {
    const deps = redeemDeps();
    const app = createSubscriptionRedeemRoute(deps);
    let last = 0;
    for (let attempt = 0; attempt <= REDEEM_LIMIT_PER_IP; attempt += 1) {
      credentialCounter += 1; // a rotating key does not reset the IP limit
      last = (
        await post(app, {
          code: "ABCD-EFGH-JKMN-PQRS",
          idempotencyKey: "phone-install-1",
        })
      ).status;
    }
    expect(last).toBe(429);
    expect(deps.calls).toHaveLength(REDEEM_LIMIT_PER_IP);
  });
});

describe("GET /api/v1/subscription/entitlement", () => {
  test("returns the signed entitlement for the caller", async () => {
    const signed: unknown[] = [];
    const app = createSubscriptionEntitlementRoute({
      authenticate: async () => USER,
      summary: async () => SUMMARY,
      sign: async (input) => {
        signed.push(input);
        return "header.payload.signature";
      },
    });
    const res = await app.request(
      "/",
      { headers: { authorization: "Bearer eliza_x" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(res)).toEqual({
      entitlement: "header.payload.signature",
    });
    expect(signed).toEqual([
      {
        userId: USER.id,
        organizationId: USER.organization_id,
        summary: SUMMARY,
      },
    ]);
  });

  test("401 for a rejected credential; 503 while signing is unavailable", async () => {
    const rejected = createSubscriptionEntitlementRoute({
      authenticate: async () => {
        throw AuthenticationError();
      },
      summary: async () => SUMMARY,
      sign: async () => "unused",
    });
    expect((await rejected.request("/", {}, ENV)).status).toBe(401);
    const unconfigured = createSubscriptionEntitlementRoute({
      authenticate: async () => USER,
      summary: async () => SUMMARY,
      sign: async () => {
        throw new EntitlementSigningUnavailableError("not configured");
      },
    });
    const res = await unconfigured.request("/", {}, ENV);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("GET /api/v1/subscription/entitlement-keys", () => {
  test("is public and publishes only public keys", async () => {
    expect(isPublicPath("/api/v1/subscription/entitlement-keys", "GET")).toBe(
      true,
    );
    expect(isPublicPath("/api/v1/subscription/entitlement", "GET")).toBe(false);
    expect(isPublicPath("/api/v1/subscription/redeem", "POST")).toBe(false);
    const keys = [
      {
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
        kid: "k1",
        alg: "ES256",
        use: "sig",
      },
    ];
    const res = await createSubscriptionEntitlementKeysRoute({
      keys: async () => ({ keys }),
    }).request("/", { headers: { "cf-connecting-ip": "203.0.113.9" } }, ENV);
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ keys });
  });

  test("503 while no signing key is configured", async () => {
    const res = await createSubscriptionEntitlementKeysRoute({
      keys: async () => {
        throw new EntitlementSigningUnavailableError("not configured");
      },
    }).request("/", { headers: { "cf-connecting-ip": "203.0.113.10" } }, ENV);
    expect(res.status).toBe(503);
  });
});
