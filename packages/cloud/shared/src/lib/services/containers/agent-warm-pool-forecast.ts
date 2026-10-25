/**
 * Warm pool demand forecasting.
 *
 * Pure functions. Inputs: counts of recent provisions per period. Outputs:
 * recommended target pool size, clamped to [minPoolSize, maxPoolSize].
 *
 * Strategy is deliberately simple — single-source rolling window with a
 * recency-weighted EMA so a quiet hour doesn't spike the pool down past the
 * floor and a sudden burst doesn't oscillate. Lead-time is the cold-start
 * cost we're trying to hide; target ≈ recent rate × lead-time + 1, clamped.
 */

export interface ForecastInput {
  /** Counts per recent window, oldest → newest. Caller picks the bucket size. */
  bucketCounts: number[];
  /** Smoothing factor 0 < α ≤ 1. Higher = more reactive to recent buckets. */
  emaAlpha: number;
  /**
   * Cold-start lead time expressed in bucket-units. If buckets are 1 hour
   * each and cold start is ~90s, leadTimeBuckets ≈ 0.025. We round up: a
   * non-zero rate always gives at least one slot above the floor.
   */
  leadTimeBuckets: number;
  /** Hard floor on pool size. Forecast never recommends below this. */
  minPoolSize: number;
  /** Hard ceiling. Forecast never recommends above this. */
  maxPoolSize: number;
}

export interface ForecastOutput {
  /** Smoothed estimate of provisions per bucket (e.g. per hour). */
  predictedRate: number;
  /** Recommended pool size (clamped). */
  targetPoolSize: number;
  /** Buckets used in the calculation (for observability). */
  observedBuckets: number;
}

/**
 * Compute target pool size from bucket counts.
 *
 * `bucketCounts` is most easily produced by counting `agent_sandboxes` rows
 * created in each of the last N hours. The caller decides how many buckets
 * (more buckets = smoother forecast, but slower to react).
 */
export function computeForecast(input: ForecastInput): ForecastOutput {
  if (input.minPoolSize > input.maxPoolSize) {
    throw new Error("warm-pool: minPoolSize cannot exceed maxPoolSize");
  }
  if (!Number.isFinite(input.emaAlpha) || input.emaAlpha <= 0 || input.emaAlpha > 1) {
    throw new Error("warm-pool: emaAlpha must satisfy 0 < α ≤ 1");
  }
  if (input.leadTimeBuckets < 0) {
    throw new Error("warm-pool: leadTimeBuckets must be non-negative");
  }

  const observedBuckets = input.bucketCounts.length;

  const predictedRate =
    observedBuckets === 0
      ? 0
      : input.bucketCounts.reduce<number>(
          (acc, count) => input.emaAlpha * count + (1 - input.emaAlpha) * acc,
          // Seed EMA at the first bucket so a single observation is honored.
          input.bucketCounts[0] ?? 0,
        );

  const recommended = Math.ceil(predictedRate * input.leadTimeBuckets) + input.minPoolSize;
  const targetPoolSize = clamp(recommended, input.minPoolSize, input.maxPoolSize);

  return { predictedRate, targetPoolSize, observedBuckets };
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export interface WarmPoolPolicy {
  /** Always keep at least this many ready. */
  minPoolSize: number;
  /** Hard cap. */
  maxPoolSize: number;
  /** Smoothing for forecast. */
  emaAlpha: number;
  /** Lead-time in bucket-units (forecast bucket = 1 hour by convention). */
  leadTimeBuckets: number;
  /** How many recent hours of provisions to consider. */
  forecastWindowHours: number;
  /**
   * Once the recommended target equals minPoolSize, drain entries older
   * than this back to the floor. Keeps a brief spike from costing all hour.
   */
  idleScaleDownMs: number;
  /** Reap pool rows stuck in pending/provisioning/error past this. */
  stuckProvisioningMs: number;
  /** Cooldown between pool replenish events (per cron tick effectively). */
  replenishCooldownMs: number;
  /** Max pool entries created in a single replenish tick. */
  replenishBurstLimit: number;
  /**
   * Node slots kept free for tenants on top of the queued tenant backlog.
   * Replenish never dips schedulable cluster slack below
   * `pendingTenantJobs + tenantReserveSlots`, so warm fill cannot starve a
   * live tenant arrival of placement capacity between daemon polls.
   */
  tenantReserveSlots: number;
  /**
   * Health probes per ready entry per sweep before it is declared dead. The
   * probe crosses the headscale mesh, which routinely has >5s transient
   * hiccups — the creator's own birth-polling observes several consecutive
   * misses before the first success on the same URL — so a single missed
   * probe must never reap a healthy container.
   */
  healthProbeAttempts: number;
  /** Spacing between those retry probes for a still-failing entry. */
  healthProbeRetryDelayMs: number;
}

export const DEFAULT_WARM_POOL_POLICY: WarmPoolPolicy = {
  minPoolSize: 1,
  maxPoolSize: 10,
  emaAlpha: 0.5,
  leadTimeBuckets: 1, // assume next hour ≈ recent rate; ceil + floor handles low rates
  forecastWindowHours: 6,
  idleScaleDownMs: 30 * 60 * 1000,
  stuckProvisioningMs: 10 * 60 * 1000,
  replenishCooldownMs: 60 * 1000,
  replenishBurstLimit: 3,
  tenantReserveSlots: 2,
  // Retries run concurrently across failing rows, so the sweep's worst-case
  // extra time is (attempts - 1) × (delay + 5s probe timeout) = 18s — well
  // inside the provisioning worker's 60s phase budget.
  healthProbeAttempts: 3,
  healthProbeRetryDelayMs: 4 * 1000,
};
