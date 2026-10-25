/**
 * Burst and sustained token buckets for assistant inference and Eliza Cloud
 * Maps, keyed by service, organization, user and plan
 * (AlphaCompute/alphaphone#410). Each service has its own buckets, so Maps
 * lookups never use up chat requests. Maps uses a plan's optional `maps`
 * limits, or the plan's own limits when that entry is absent.
 *
 * The decision uses process memory only. It never reads billing, Postgres, KV
 * or a Durable Object, so it adds no network round trip to an assistant turn.
 * The plan comes from the admission snapshot that the inference auth cache
 * already carries. The buckets are local to one Worker isolate: they stop a
 * burst early and cheaply, and the existing per-organization Durable Object
 * window stays the global per-minute authority.
 *
 * Numbers are configuration. They are not selected: the owner selects them
 * from measured provider cost and pilot traffic. `ELIZA_CLOUD_PLAN_RATE_LIMITS`:
 *   unset or empty  the limiter is off (no invented number is enforced)
 *   `placeholder`   {@link UNSELECTED_PLAN_REQUEST_LIMITS}, for staging and benchmarks
 *   JSON            `{"selected":bool,"plans":{"default":{...},"<plan_key>":{...}}}`
 *                   where each plan is `{"burst":B,"sustained":B,"maps"?:{"burst":B,"sustained":B}}`
 *                   and B is `{"capacity":int>=1,"refillPerSecond":number>0}`.
 *
 * Plan resolution: the snapshot plan key when it is configured and its policy
 * window has not ended; otherwise `default`. So a cache miss (no snapshot), an
 * expired plan window and a billing outage all decide from memory with the
 * `default` limits.
 *
 * Cap semantics: the buckets live in one Worker isolate. A caller whose
 * requests reach N isolates gets up to N full buckets. A bucket evicted from
 * the bounded map (MAX_BUCKETS, shared by every service) also starts full
 * again. So the buckets bound bursts; they are not an exact global cap. The
 * organization Durable Object window (`completionsRpm`) is the cross-isolate
 * cap for inference; Maps has only these buckets and the per-credential
 * route limit. There is no shared bucket backend: KV is
 * eventually consistent and cannot count, and a Durable Object or Redis
 * bucket is a network round trip on every turn. The one shared option with no
 * added round trip is to carry the buckets in the organization gate's existing
 * `/rate-limit` call; that runs only after the policy read, so a refusal would
 * no longer be free.
 */
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export const PLAN_REQUEST_LIMITS_ENV = "ELIZA_CLOUD_PLAN_RATE_LIMITS";
export const DEFAULT_PLAN_LIMIT_KEY = "default";

export interface TokenBucketLimit {
  capacity: number;
  refillPerSecond: number;
}

export interface ServiceRequestLimits {
  burst: TokenBucketLimit;
  sustained: TokenBucketLimit;
}

export interface PlanRequestLimits extends ServiceRequestLimits {
  /** Maps limits for this plan; Maps uses the plan's own limits when absent. */
  maps?: ServiceRequestLimits;
}

export interface PlanRequestLimitConfig {
  /** False until the owner selects the numbers; reported in every refusal. */
  selected: boolean;
  plans: Record<string, PlanRequestLimits>;
}

/**
 * UNSELECTED PLACEHOLDERS. These numbers are not an owner decision and are
 * not derived from provider cost or pilot traffic. They exist so staging and
 * the latency benchmark can run the limiter. Production must set its own.
 */
export const UNSELECTED_PLAN_REQUEST_LIMITS: PlanRequestLimitConfig = Object.freeze({
  selected: false,
  plans: Object.freeze({
    [DEFAULT_PLAN_LIMIT_KEY]: Object.freeze({
      burst: Object.freeze({ capacity: 10, refillPerSecond: 0.5 }),
      sustained: Object.freeze({ capacity: 600, refillPerSecond: 600 / 3_600 }),
    }),
  }),
});

export class PlanRequestLimitConfigError extends Error {
  constructor(message: string) {
    super(`${PLAN_REQUEST_LIMITS_ENV}: ${message}`);
    this.name = "PlanRequestLimitConfigError";
  }
}

function bucketLimit(value: unknown, path: string): TokenBucketLimit {
  const row = value as Partial<TokenBucketLimit> | null;
  if (
    !row ||
    typeof row !== "object" ||
    !Number.isSafeInteger(row.capacity) ||
    (row.capacity as number) < 1 ||
    typeof row.refillPerSecond !== "number" ||
    !Number.isFinite(row.refillPerSecond) ||
    row.refillPerSecond <= 0
  )
    throw new PlanRequestLimitConfigError(
      `${path} needs an integer capacity >= 1 and a refillPerSecond > 0`,
    );
  return { capacity: row.capacity as number, refillPerSecond: row.refillPerSecond };
}

/** Parses the JSON form. Throws PlanRequestLimitConfigError for any invalid field. */
export function parsePlanRequestLimitConfig(raw: string): PlanRequestLimitConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PlanRequestLimitConfigError("is not JSON or `placeholder`");
  }
  const root = parsed as { selected?: unknown; plans?: unknown } | null;
  if (!root || typeof root !== "object" || !root.plans || typeof root.plans !== "object")
    throw new PlanRequestLimitConfigError("needs a `plans` object");
  if (root.selected !== undefined && typeof root.selected !== "boolean")
    throw new PlanRequestLimitConfigError("`selected` must be a boolean");
  const plans: Record<string, PlanRequestLimits> = {};
  for (const [key, value] of Object.entries(root.plans as Record<string, unknown>)) {
    const row = value as { burst?: unknown; sustained?: unknown; maps?: unknown } | null;
    plans[key] = {
      burst: bucketLimit(row?.burst, `plans.${key}.burst`),
      sustained: bucketLimit(row?.sustained, `plans.${key}.sustained`),
    };
    if (row?.maps !== undefined) {
      const maps = row.maps as { burst?: unknown; sustained?: unknown } | null;
      plans[key].maps = {
        burst: bucketLimit(maps?.burst, `plans.${key}.maps.burst`),
        sustained: bucketLimit(maps?.sustained, `plans.${key}.maps.sustained`),
      };
    }
  }
  if (!plans[DEFAULT_PLAN_LIMIT_KEY])
    throw new PlanRequestLimitConfigError(`needs a plans.${DEFAULT_PLAN_LIMIT_KEY} entry`);
  return { selected: root.selected === true, plans };
}

let cachedConfig: { raw: string; config: PlanRequestLimitConfig | null } | null = null;

/** The active configuration, or null when the limiter is off. */
export function readPlanRequestLimitConfig(
  env: Record<string, string | undefined> = getCloudAwareEnv(),
): PlanRequestLimitConfig | null {
  const raw = (env[PLAN_REQUEST_LIMITS_ENV] ?? "").trim();
  if (cachedConfig?.raw === raw) return cachedConfig.config;
  const config =
    raw === ""
      ? null
      : raw === "placeholder"
        ? UNSELECTED_PLAN_REQUEST_LIMITS
        : parsePlanRequestLimitConfig(raw);
  cachedConfig = { raw, config };
  return config;
}

export type PlanRequestService = "inference" | "maps";

export interface PlanRequestIdentity {
  /** Defaults to inference. Each service has its own buckets. */
  service?: PlanRequestService;
  organizationId: string;
  userId?: string | null;
  /** Plan key from the cached admission snapshot; absent on a cache miss. */
  planKey?: string | null;
  /** End of the cached plan policy window (ISO), when one is known. */
  planEffectiveUntil?: string | null;
}

export type PlanRequestDecision =
  | { allowed: true; plan: string }
  | {
      allowed: false;
      plan: string;
      bucket: "burst" | "sustained";
      retryAfterMs: number;
      limit: TokenBucketLimit;
      selected: boolean;
    };

interface BucketState {
  burst: number;
  sustained: number;
  at: number;
}

const MAX_BUCKETS = 10_000;
const buckets = new Map<string, BucketState>();

/** Test and benchmark hook: forget every bucket and the parsed configuration. */
export function resetPlanRequestLimiterForTests(): void {
  buckets.clear();
  cachedConfig = null;
}

function resolvePlan(identity: PlanRequestIdentity, config: PlanRequestLimitConfig, now: number) {
  const key = identity.planKey;
  if (!key || key === DEFAULT_PLAN_LIMIT_KEY || !Object.hasOwn(config.plans, key))
    return DEFAULT_PLAN_LIMIT_KEY;
  if (identity.planEffectiveUntil) {
    const until = Date.parse(identity.planEffectiveUntil);
    if (!Number.isFinite(until) || until <= now) return DEFAULT_PLAN_LIMIT_KEY;
  }
  return key;
}

function waitMs(tokens: number, limit: TokenBucketLimit): number {
  return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / limit.refillPerSecond) * 1_000);
}

/** Takes one request from both buckets, or refuses without taking any. */
export function consumePlanRequest(
  identity: PlanRequestIdentity,
  config: PlanRequestLimitConfig,
  now: number = Date.now(),
): PlanRequestDecision {
  const plan = resolvePlan(identity, config, now);
  const planLimits = config.plans[plan];
  const limits: ServiceRequestLimits =
    identity.service === "maps" ? (planLimits.maps ?? planLimits) : planLimits;
  const key = `${identity.service ?? "inference"}\0${identity.organizationId}\0${identity.userId ?? ""}\0${plan}`;
  let state = buckets.get(key);
  if (state) {
    buckets.delete(key);
    const elapsed = Math.max(0, now - state.at) / 1_000;
    state.burst = Math.min(
      limits.burst.capacity,
      state.burst + elapsed * limits.burst.refillPerSecond,
    );
    state.sustained = Math.min(
      limits.sustained.capacity,
      state.sustained + elapsed * limits.sustained.refillPerSecond,
    );
    state.at = now;
  } else {
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    state = { burst: limits.burst.capacity, sustained: limits.sustained.capacity, at: now };
  }
  buckets.set(key, state);

  if (state.burst >= 1 && state.sustained >= 1) {
    state.burst -= 1;
    state.sustained -= 1;
    return { allowed: true, plan };
  }
  const burstWait = waitMs(state.burst, limits.burst);
  const sustainedWait = waitMs(state.sustained, limits.sustained);
  const bucket = sustainedWait >= burstWait ? "sustained" : "burst";
  return {
    allowed: false,
    plan,
    bucket,
    retryAfterMs: Math.max(burstWait, sustainedWait),
    limit: limits[bucket],
    selected: config.selected,
  };
}

/**
 * 429 for a plan bucket refusal. The body carries the retry time because the
 * native client reads the body only; `Retry-After` is set for HTTP clients.
 */
export function planRequestLimitedResponse(
  decision: Extract<PlanRequestDecision, { allowed: false }>,
  now: number = Date.now(),
): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1_000));
  return Response.json(
    {
      error: {
        message:
          decision.bucket === "burst"
            ? "Too many requests in a short time for this plan. Retry after the wait."
            : "This plan's sustained request rate is used up. Retry after the wait.",
        type: "rate_limit_error",
        code: "rate_limited",
        retryAfterSeconds,
        retryAfterMs: decision.retryAfterMs,
        retryAt: new Date(now + decision.retryAfterMs).toISOString(),
        plan: { id: decision.plan },
        limit: {
          bucket: decision.bucket,
          capacity: decision.limit.capacity,
          refillPerSecond: decision.limit.refillPerSecond,
          selected: decision.selected,
        },
      },
    },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Policy": "plan-token-bucket",
      },
    },
  );
}

/**
 * Applies the plan buckets when the limiter is configured. Returns the 429
 * response on refusal, or null when the request may continue.
 */
export function enforcePlanRequestLimit(identity: PlanRequestIdentity): Response | null {
  const config = readPlanRequestLimitConfig();
  if (!config) return null;
  const now = Date.now();
  const decision = consumePlanRequest(identity, config, now);
  return decision.allowed ? null : planRequestLimitedResponse(decision, now);
}
