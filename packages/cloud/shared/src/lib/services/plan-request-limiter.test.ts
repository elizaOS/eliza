import { beforeEach, describe, expect, test } from "bun:test";
import {
  consumePlanRequest,
  type PlanRequestLimitConfig,
  PlanRequestLimitConfigError,
  planRequestLimitedResponse,
  readPlanRequestLimitConfig,
  resetPlanRequestLimiterForTests,
  UNSELECTED_PLAN_REQUEST_LIMITS,
} from "./plan-request-limiter";

const ORG = "org-1";
const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const CONFIG: PlanRequestLimitConfig = {
  selected: false,
  plans: {
    default: {
      burst: { capacity: 2, refillPerSecond: 1 },
      sustained: { capacity: 3, refillPerSecond: 0.01 },
    },
    plus_monthly: {
      burst: { capacity: 5, refillPerSecond: 1 },
      sustained: { capacity: 100, refillPerSecond: 1 },
    },
  },
};

beforeEach(() => resetPlanRequestLimiterForTests());

describe("plan request buckets", () => {
  test("a burst is refused until the burst bucket refills", () => {
    const id = { organizationId: ORG, userId: "u1" };
    expect(consumePlanRequest(id, CONFIG, T0).allowed).toBe(true);
    expect(consumePlanRequest(id, CONFIG, T0).allowed).toBe(true);
    const refused = consumePlanRequest(id, CONFIG, T0);
    expect(refused).toMatchObject({ allowed: false, bucket: "burst", retryAfterMs: 1_000 });
    expect(consumePlanRequest(id, CONFIG, T0 + 1_000).allowed).toBe(true);
  });

  test("the sustained bucket refuses after the burst refills", () => {
    const id = { organizationId: ORG, userId: "u1" };
    for (const at of [T0, T0, T0 + 2_000])
      expect(consumePlanRequest(id, CONFIG, at).allowed).toBe(true);
    const refused = consumePlanRequest(id, CONFIG, T0 + 4_000);
    expect(refused).toMatchObject({ allowed: false, bucket: "sustained", plan: "default" });
    if (refused.allowed) throw new Error("expected a refusal");
    // 0.04 tokens refilled at 0.01/s: 96 seconds to the next whole token.
    expect(refused.retryAfterMs).toBe(96_000);
  });

  test("Maps and inference have separate buckets", () => {
    const id = { organizationId: ORG, userId: "u1" };
    for (let i = 0; i < 2; i++) consumePlanRequest(id, CONFIG, T0);
    expect(consumePlanRequest(id, CONFIG, T0).allowed).toBe(false);
    expect(consumePlanRequest({ ...id, service: "maps" }, CONFIG, T0).allowed).toBe(true);
  });

  test("a plan's maps entry sets Maps limits apart from inference", () => {
    const config = readPlanRequestLimitConfig({
      ELIZA_CLOUD_PLAN_RATE_LIMITS: JSON.stringify({
        plans: {
          default: {
            ...CONFIG.plans.default,
            maps: {
              burst: { capacity: 1, refillPerSecond: 1 },
              sustained: { capacity: 3, refillPerSecond: 1 },
            },
          },
        },
      }),
    });
    if (!config) throw new Error("expected a configuration");
    const maps = { organizationId: ORG, userId: "u1", service: "maps" as const };
    expect(consumePlanRequest(maps, config, T0).allowed).toBe(true);
    expect(consumePlanRequest(maps, config, T0)).toMatchObject({
      allowed: false,
      limit: { capacity: 1 },
    });
    expect(consumePlanRequest({ organizationId: ORG, userId: "u1" }, config, T0).allowed).toBe(
      true,
    );
    expect(() =>
      readPlanRequestLimitConfig({
        ELIZA_CLOUD_PLAN_RATE_LIMITS: JSON.stringify({
          plans: { default: { ...CONFIG.plans.default, maps: { burst: {} } } },
        }),
      }),
    ).toThrow(PlanRequestLimitConfigError);
  });

  test("buckets are separate per user and per plan", () => {
    for (let i = 0; i < 2; i++)
      consumePlanRequest({ organizationId: ORG, userId: "u1" }, CONFIG, T0);
    expect(consumePlanRequest({ organizationId: ORG, userId: "u1" }, CONFIG, T0).allowed).toBe(
      false,
    );
    expect(consumePlanRequest({ organizationId: ORG, userId: "u2" }, CONFIG, T0).allowed).toBe(
      true,
    );
    expect(
      consumePlanRequest(
        { organizationId: ORG, userId: "u1", planKey: "plus_monthly" },
        CONFIG,
        T0,
      ),
    ).toEqual({ allowed: true, plan: "plus_monthly" });
  });

  test("an unknown plan, a cache miss and an ended plan window use the default limits", () => {
    const until = new Date(T0 - 1).toISOString();
    expect(consumePlanRequest({ organizationId: ORG, planKey: "pro_monthly" }, CONFIG, T0)).toEqual(
      { allowed: true, plan: "default" },
    );
    expect(consumePlanRequest({ organizationId: ORG, userId: "miss" }, CONFIG, T0)).toEqual({
      allowed: true,
      plan: "default",
    });
    expect(
      consumePlanRequest(
        { organizationId: ORG, userId: "x", planKey: "plus_monthly", planEffectiveUntil: until },
        CONFIG,
        T0,
      ),
    ).toEqual({ allowed: true, plan: "default" });
  });
});

describe("configuration", () => {
  test("unset is off, `placeholder` is the unselected template, JSON is validated", () => {
    expect(readPlanRequestLimitConfig({})).toBeNull();
    expect(readPlanRequestLimitConfig({ ELIZA_CLOUD_PLAN_RATE_LIMITS: "placeholder" })).toBe(
      UNSELECTED_PLAN_REQUEST_LIMITS,
    );
    expect(UNSELECTED_PLAN_REQUEST_LIMITS.selected).toBe(false);
    expect(
      readPlanRequestLimitConfig({ ELIZA_CLOUD_PLAN_RATE_LIMITS: JSON.stringify(CONFIG) }),
    ).toEqual(CONFIG);
    for (const bad of [
      "{",
      JSON.stringify({ plans: {} }),
      JSON.stringify({
        plans: {
          default: {
            burst: { capacity: 0, refillPerSecond: 1 },
            sustained: { capacity: 1, refillPerSecond: 1 },
          },
        },
      }),
      JSON.stringify({ selected: "yes", plans: CONFIG.plans }),
    ])
      expect(() => readPlanRequestLimitConfig({ ELIZA_CLOUD_PLAN_RATE_LIMITS: bad })).toThrow(
        PlanRequestLimitConfigError,
      );
  });
});

describe("refusal body", () => {
  test("429 carries the retry time in the body and in Retry-After", async () => {
    const id = { organizationId: ORG, userId: "u1" };
    consumePlanRequest(id, CONFIG, T0);
    consumePlanRequest(id, CONFIG, T0);
    const refused = consumePlanRequest(id, CONFIG, T0);
    if (refused.allowed) throw new Error("expected a refusal");
    const response = planRequestLimitedResponse(refused, T0);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("X-RateLimit-Policy")).toBe("plan-token-bucket");
    expect(await response.json()).toEqual({
      error: {
        message: "Too many requests in a short time for this plan. Retry after the wait.",
        type: "rate_limit_error",
        code: "rate_limited",
        retryAfterSeconds: 1,
        retryAfterMs: 1_000,
        retryAt: "2026-10-14T12:00:01.000Z",
        plan: { id: "default" },
        limit: { bucket: "burst", capacity: 2, refillPerSecond: 1, selected: false },
      },
    });
  });
});
