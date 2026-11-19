import { beforeEach, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { HTTPException } from "hono/http-exception";

let authenticated = true;
const unavailableKeys = new Set<string>();
const counts = new Map<string, number>();
const expiration = new Map<string, number>();
let clock = 0;

function organizationCalls(key: string) {
  return counts.get(`ratelimit:${key}`);
}

function seedOrganizationCalls(key: string, count: number) {
  const storeKey = `ratelimit:${key}`;
  counts.set(storeKey, count);
  expiration.set(storeKey, clock + 86_400_000);
}

mock.module("@elizaos/cloud-shared/lib/cache/redis-factory", () => ({
  buildRedisClient: () => ({
    pipeline() {
      const commands: Array<() => number> = [];
      const pipeline = {
        incr(key: string) {
          commands.push(() => {
            if (unavailableKeys.has(key)) throw new Error("Redis unavailable");
            if ((expiration.get(key) ?? 0) <= clock) {
              expiration.delete(key);
              counts.delete(key);
            }
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return next;
          });
          return pipeline;
        },
        pttl(key: string) {
          commands.push(() => (expiration.get(key) ?? clock - 1) - clock);
          return pipeline;
        },
        async exec() {
          return commands.map((command) => command());
        },
      };
      return pipeline;
    },
    async pexpire(key: string, ttl: number) {
      expiration.set(key, clock + ttl);
      return 1;
    },
  }),
}));

const freePolicy = {
  authority: { source: "legacy" },
  subscriptionFunded: false,
  tierSourceCreditTotal: "0" as string | null,
  tier: { status: "available", value: { strictRpm: 2 } },
};
let policy = freePolicy;
let policyError = false;
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-quota-policy",
  () => ({
    requireOrganizationRateTier: () => {
      throw new Error(
        "Clef requires a quota observation, not an inference tier",
      );
    },
    readOrganizationQuotaPolicy: async () => {
      if (policyError) throw new Error("Billing policy storage unavailable");
      return policy;
    },
  }),
);
const logged: unknown[][] = [];
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (!authenticated) throw new HTTPException(401);
    return { id: "user-1", organization_id: "org-1" };
  },
}));
const record =
  (level: string) =>
  (...args: unknown[]) =>
    logged.push([level, ...args]);
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  },
}));
const { default: app } = await import("./route");

const SECRET = "pay the electric bill with card 4111";
const modeRequest = { kind: "mode", action: SECRET, context: SECRET };

function post(
  body: unknown,
  env: Record<string, unknown>,
  key = "eliza_test_first",
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  authenticated = true;
  counts.clear();
  expiration.clear();
  unavailableKeys.clear();
  clock = 0;
  policy = freePolicy;
  policyError = false;
  logged.length = 0;
});

test("route is rate limited and authenticated before any Clef call", async () => {
  const runs: unknown[] = [];
  const AI = { run: async (...args: unknown[]) => runs.push(args) };
  authenticated = false;
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
  expect(counts.size).toBe(1);
  expect(runs).toHaveLength(0);
});

const ORG_DAILY = {
  windowMs: 86_400_000,
  maxRequests: 2_000,
  key: "clef-decisions:org:org-1",
};

test("each Clef call counts against the organization's daily cap", async () => {
  const AI = {
    run: async () => ({
      model: "clef-flash",
      answers: { ask: { type: "noul", noul: 0.1 } },
    }),
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("X-RateLimit-Limit")).toBe("2000");
  expect(organizationCalls(ORG_DAILY.key)).toBe(1);
});

test("an organization over its daily cap gets 429 and no Clef call", async () => {
  const runs: unknown[] = [];
  const AI = { run: async (...args: unknown[]) => runs.push(args) };
  seedOrganizationCalls(ORG_DAILY.key, 2_000);
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(429);
  expect(runs).toHaveLength(0);
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

test("a settled purchase raises the same organization's cap until revoked", async () => {
  const run = mock(async () => ({
    model: "clef-flash",
    answers: { ask: { type: "noul", noul: 0.1 } },
  }));
  const env = { AI: { run }, CLEF_DECISIONS_ENABLED: "true" };
  seedOrganizationCalls(ORG_DAILY.key, 2_000);

  policy = { ...freePolicy, tierSourceCreditTotal: "4.99" };
  expect((await post(modeRequest, env)).status).toBe(429);

  policy = { ...freePolicy, tierSourceCreditTotal: "5.00" };
  const funded = await post(modeRequest, env);
  expect(funded.status).toBe(200);
  expect(funded.headers.get("X-RateLimit-Limit")).toBe("4000");
  expect(organizationCalls(ORG_DAILY.key)).toBe(2_002);

  policy = freePolicy;
  expect((await post(modeRequest, env)).status).toBe(429);
  expect(run).toHaveBeenCalledTimes(1);
});

test("a funded subscription raises the cap while a promo grant or unavailable policy keeps the base cap", async () => {
  const run = mock(async () => ({
    model: "clef-flash",
    answers: { ask: { type: "noul", noul: 0.1 } },
  }));
  const env = { AI: { run }, CLEF_DECISIONS_ENABLED: "true" };
  seedOrganizationCalls(ORG_DAILY.key, 2_000);
  const funded = {
    ...freePolicy,
    subscriptionFunded: true,
    tierSourceCreditTotal: null,
  };

  policy = { ...funded, authority: { source: "subscription" } };
  expect((await post(modeRequest, env)).status).toBe(200);

  policy = { ...funded, authority: { source: "promo_grant" } };
  expect((await post(modeRequest, env)).status).toBe(429);

  policy = {
    ...funded,
    authority: { source: "subscription" },
    tier: { status: "unavailable", value: { strictRpm: 2 } },
  };
  expect((await post(modeRequest, env)).status).toBe(429);

  policyError = true;
  expect((await post(modeRequest, env)).status).toBe(429);
  expect(run).toHaveBeenCalledTimes(1);
});

test("a subscription renews included capacity beyond the daily burst across credentials", async () => {
  const run = mock(async () => ({
    model: "clef-flash",
    answers: { ask: { type: "noul", noul: 0.1 } },
  }));
  const env = { AI: { run }, CLEF_DECISIONS_ENABLED: "true" };
  const minuteKey = `${ORG_DAILY.key}:subscription-minute`;
  seedOrganizationCalls(ORG_DAILY.key, 3_999);
  policy = {
    ...freePolicy,
    authority: { source: "subscription" },
    subscriptionFunded: true,
    tierSourceCreditTotal: null,
  };

  const finalDaily = await post(modeRequest, env);
  expect([
    finalDaily.status,
    finalDaily.headers.get("X-RateLimit-Limit"),
  ]).toEqual([200, "4000"]);
  expect(organizationCalls(minuteKey)).toBeUndefined();
  const accepted = await Promise.all([
    post(modeRequest, env),
    post(modeRequest, env, "eliza_test_second"),
  ]);
  for (const response of accepted) {
    expect([
      response.status,
      response.headers.get("X-Clef-Rate-Limit-Scope"),
      response.headers.get("X-RateLimit-Limit"),
      response.headers.get("Retry-After"),
    ]).toEqual([200, "subscription-minute", "2", null]);
  }

  const capped = await post(modeRequest, env, "eliza_test_second");
  expect([
    capped.status,
    capped.headers.get("X-Clef-Rate-Limit-Scope"),
    capped.headers.get("X-RateLimit-Remaining"),
  ]).toEqual([429, "subscription-minute", "0"]);
  expect(capped.headers.get("Retry-After")).toBe("60");
  expect(organizationCalls(ORG_DAILY.key)).toBe(4_003);

  clock += 60_000;
  const renewed = await post(modeRequest, env);
  expect([
    renewed.status,
    renewed.headers.get("X-Clef-Rate-Limit-Scope"),
    renewed.headers.get("X-RateLimit-Remaining"),
    renewed.headers.get("Retry-After"),
  ]).toEqual([200, "subscription-minute", "1", null]);
  expect(run).toHaveBeenCalledTimes(4);

  unavailableKeys.add(`ratelimit:${ORG_DAILY.key}`);
  expect((await post(modeRequest, env)).status).toBe(503);
  unavailableKeys.clear();
  unavailableKeys.add(`ratelimit:${minuteKey}`);
  const minuteUnavailable = await post(modeRequest, env);
  expect([
    minuteUnavailable.status,
    minuteUnavailable.headers.get("X-Clef-Rate-Limit-Scope"),
  ]).toEqual([503, "subscription-minute"]);
  unavailableKeys.clear();
  policy = freePolicy;
  const revoked = await post(modeRequest, env);
  expect([
    revoked.status,
    revoked.headers.get("X-Clef-Rate-Limit-Scope"),
  ]).toEqual([429, "organization-day"]);
  expect(run).toHaveBeenCalledTimes(4);
});

test("disabled and invalid requests do not spend the daily cap", async () => {
  await post(modeRequest, { CLEF_DECISIONS_ENABLED: "false" });
  await post({ kind: "mode", action: "" }, { CLEF_DECISIONS_ENABLED: "true" });
  expect(organizationCalls(ORG_DAILY.key)).toBeUndefined();
});

test("route answers 503 unavailable while disabled or without the AI binding", async () => {
  const AI = { run: async () => ({}) };
  for (const env of [
    { AI },
    { AI, CLEF_DECISIONS_ENABLED: "false" },
    { CLEF_DECISIONS_ENABLED: "true" },
  ]) {
    const response = await post(modeRequest, env);
    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
  }
});

test("route asks Clef flash through the AI binding and returns the typed answer", async () => {
  const runs: unknown[][] = [];
  const AI = {
    run: async (...args: unknown[]) => {
      runs.push(args);
      return {
        model: "clef-flash",
        answers: { ask: { type: "noul", noul: 0.97 } },
      };
    },
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()) as unknown).toEqual({
    status: "ok",
    kind: "mode",
    model: "clef-flash",
    suggestedMode: "ask",
    askProbability: 0.97,
  });
  expect(runs).toHaveLength(1);
  expect(runs[0]?.[0]).toBe("@cf/cloudflare/clef-flash");
});

test("provider failure answers 503 and never logs request text", async () => {
  const AI = {
    run: async () => {
      throw new Error(`upstream echoed ${SECRET}`);
    },
  };
  const response = await post(modeRequest, {
    AI,
    CLEF_DECISIONS_ENABLED: "true",
  });
  expect(response.status).toBe(503);
  expect((await response.json()) as unknown).toEqual({
    status: "unavailable",
    reason: "provider_error",
  });
  expect(logged).toEqual([
    ["warn", "[Decisions] Clef unavailable", { code: "CLEF_PROVIDER_FAILED" }],
  ]);
  expect(JSON.stringify(logged)).not.toContain(SECRET);
});

test("invalid requests are refused without echoing their text", async () => {
  const response = await post(
    { kind: "mode", action: "" },
    {
      CLEF_DECISIONS_ENABLED: "true",
    },
  );
  expect(response.status).toBe(400);
  expect((await response.json()) as unknown).toEqual({
    error: "Invalid decision request",
    field: "action",
  });
  expect(logged).toHaveLength(0);
});

test("staging and production enable decisions on the Workers AI binding", async () => {
  const config = Bun.TOML.parse(
    await readFile(new URL("../../wrangler.toml", import.meta.url), "utf8"),
  ) as {
    env: Record<
      string,
      { ai?: { binding?: string }; vars?: Record<string, string> }
    >;
  };
  for (const environment of ["staging", "production"]) {
    expect(config.env[environment]?.ai?.binding).toBe("AI");
    expect(config.env[environment]?.vars?.CLEF_DECISIONS_ENABLED).toBe("true");
    // The limits fail closed, so the route needs the shared Redis limiter.
    expect(config.env[environment]?.vars?.REDIS_RATE_LIMITING).toBe("true");
  }
});
