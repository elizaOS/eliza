/** Durable organization Maps count and observational usage. No inference balance or money is mutated. */
import {
  type MapsAllowanceRequest,
  type MapsUsageOutcome,
  mapsRequestAllowance,
} from "@elizaos/cloud-shared/lib/services/maps-request-policy";
import {
  readPlanRequestLimitConfig,
  type TokenBucketLimit,
} from "@elizaos/cloud-shared/lib/services/plan-request-limiter";

type Bucket = { tokens: number; at: number };
type Window = {
  start: number;
  end: number;
  used: number;
  burst?: Bucket;
  sustained?: Bucket;
};
type Usage = {
  operation: string;
  userId: string;
  windowStart: number;
  admittedAt: number;
  outcome: "unknown" | MapsUsageOutcome;
};
const WINDOW_KEY = "maps:allowance:window";
const fail = (
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
) => Response.json({ error: { code, ...extra } }, { status });
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
function valid(value: unknown): value is MapsAllowanceRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as MapsAllowanceRequest;
  return (
    id(v.organizationId) &&
    id(v.requestId) &&
    !!v.credential &&
    (v.credential.kind === "api_key" ||
      v.credential.kind === "steward_session") &&
    v.credential.organizationId === v.organizationId &&
    (v.credential.kind === "api_key"
      ? id(v.credential.credentialId)
      : id(v.credential.stewardUserId) &&
        Number.isSafeInteger(v.credential.issuedAt) &&
        v.credential.issuedAt > 0) &&
    id(v.credential.userId) &&
    ["search", "geocode", "reverse", "details", "routes"].includes(
      v.operation,
    ) &&
    !!v.policy &&
    typeof v.policy.generation === "string" &&
    /^(0|[1-9]\d*)$/.test(v.policy.generation) &&
    typeof v.policy.planKey === "string" &&
    v.policy.planKey.length <= 128 &&
    v.policy.subscriptionFunded === true &&
    typeof v.policy.effectiveFrom === "string" &&
    (v.policy.effectiveUntil === null ||
      typeof v.policy.effectiveUntil === "string")
  );
}
function refill(
  current: Bucket | undefined,
  limit: TokenBucketLimit,
  now: number,
): Bucket {
  return {
    tokens: Math.min(
      limit.capacity,
      (current?.tokens ?? limit.capacity) +
        (Math.max(0, now - (current?.at ?? now)) * limit.refillPerSecond) /
          1000,
    ),
    at: now,
  };
}
export class MapsRequestAllowanceController {
  constructor(
    private storage: DurableObjectStorage,
    private env: Record<string, unknown>,
    private authority: {
      credential(
        value: MapsAllowanceRequest["credential"],
      ): Promise<Response | null>;
    },
  ) {}
  /** The internal caller holds the primary policy read lock through admission.
   * The gate orders this operation with credential revocation. No cached policy
   * is accepted until policy writers publish a synchronous revocation fence. */
  async handle(path: string, value: unknown): Promise<Response> {
    if (!valid(value)) return fail("maps_allowance_invalid_request", 400);
    const request = value;
    const denied = await this.authority.credential(request.credential);
    if (denied) return denied;
    const credentialKey =
      request.credential.kind === "api_key"
        ? `key:${request.credential.credentialId}`
        : `session:${request.credential.stewardUserId}:${request.credential.issuedAt}`;
    const key = `maps:usage:${credentialKey}:${request.requestId}`;
    if (path === "/maps/usage") {
      const outcome = (value as MapsAllowanceRequest & { outcome?: unknown })
        .outcome;
      if (
        outcome !== "succeeded" &&
        outcome !== "failed" &&
        outcome !== "cancelled"
      )
        return fail("maps_usage_invalid_outcome", 400);
      return this.storage.transaction(async (tx) => {
        const usage = await tx.get<Usage>(key);
        if (
          !usage ||
          usage.operation !== request.operation ||
          usage.userId !== request.credential.userId
        )
          return fail("maps_usage_identity_conflict", 409);
        if (usage.outcome !== "unknown" && usage.outcome !== outcome)
          return fail("maps_usage_outcome_conflict", 409);
        if (usage.outcome === "unknown")
          await tx.put(key, { ...usage, outcome });
        return Response.json({ recorded: true });
      });
    }
    if (path !== "/maps/admit")
      return fail("maps_allowance_invalid_route", 404);
    const now = Date.now();
    const from = Date.parse(request.policy.effectiveFrom),
      until =
        request.policy.effectiveUntil === null
          ? Infinity
          : Date.parse(request.policy.effectiveUntil);
    if (
      !Number.isFinite(from) ||
      Number.isNaN(until) ||
      now < from ||
      now >= until
    )
      return fail("maps_policy_stale", 503);
    let allowance;
    let limits;
    try {
      allowance = mapsRequestAllowance(this.env, request.policy.planKey);
      const config = readPlanRequestLimitConfig(
        this.env as Record<string, string | undefined>,
      );
      if (!config?.selected) return fail("maps_allowance_unconfigured", 503);
      const plan = config
        ? Object.hasOwn(config.plans, request.policy.planKey)
          ? config.plans[request.policy.planKey]
          : config.plans.default
        : undefined;
      limits = plan?.maps ?? plan;
    } catch {
      return fail("maps_allowance_unconfigured", 503);
    }
    if (!allowance || !limits) return fail("maps_allowance_unconfigured", 503);
    const period = allowance.windowSeconds * 1000;
    const start = Math.floor(now / period) * period,
      end = start + period;
    return this.storage.transaction(async (tx) => {
      const previous = await tx.get<Usage>(key);
      if (previous)
        return fail(
          previous.operation === request.operation &&
            previous.userId === request.credential.userId
            ? "maps_request_already_admitted"
            : "maps_request_identity_conflict",
          409,
        );
      const old = await tx.get<Window>(WINDOW_KEY);
      if (old && old.end > now && (old.start !== start || old.end !== end))
        return fail("maps_allowance_window_conflict", 503);
      if (
        old &&
        (!Number.isSafeInteger(old.used) ||
          old.used < 0 ||
          !Number.isSafeInteger(old.start) ||
          !Number.isSafeInteger(old.end) ||
          old.end <= old.start ||
          [old.burst, old.sustained].some(
            (b) =>
              b &&
              (!Number.isFinite(b.tokens) ||
                b.tokens < 0 ||
                !Number.isFinite(b.at)),
          ))
      )
        return fail("maps_allowance_storage_invalid", 503);
      const window: Window =
        old && old.end > now
          ? { ...old }
          : {
              start,
              end,
              used: 0,
              ...(old?.burst && { burst: old.burst }),
              ...(old?.sustained && { sustained: old.sustained }),
            };
      if (window.used >= allowance.requests)
        return fail("allowance_exhausted", 429, {
          service: "maps",
          resetsAt: new Date(end).toISOString(),
          retryAfterSeconds: Math.max(1, Math.ceil((end - now) / 1000)),
        });
      if (limits) {
        const burst = refill(window.burst, limits.burst, now),
          sustained = refill(window.sustained, limits.sustained, now);
        if (burst.tokens < 1 || sustained.tokens < 1)
          return fail("rate_limited", 429, {
            service: "maps",
            retryAfterSeconds: Math.max(
              1,
              Math.ceil(
                Math.max(
                  (1 - burst.tokens) / limits.burst.refillPerSecond,
                  (1 - sustained.tokens) / limits.sustained.refillPerSecond,
                ),
              ),
            ),
          });
        window.burst = { ...burst, tokens: burst.tokens - 1 };
        window.sustained = { ...sustained, tokens: sustained.tokens - 1 };
      }
      window.used++;
      await tx.put({
        [WINDOW_KEY]: window,
        [key]: {
          operation: request.operation,
          userId: request.credential.userId,
          windowStart: start,
          admittedAt: now,
          outcome: "unknown",
        } satisfies Usage,
      });
      return Response.json({
        admitted: true,
        remaining: allowance.requests - window.used,
        resetsAt: new Date(end).toISOString(),
      });
    });
  }
}
