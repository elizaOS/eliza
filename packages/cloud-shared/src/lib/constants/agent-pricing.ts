/**
 * Pricing constants for Eliza Cloud hosted agents (Docker-based).
 *
 * These agents run on dedicated Hetzner servers, not AWS ECS.
 * Pricing is hourly-based and billed by an hourly cron.
 *
 * Running agents:  $0.01/hour  (~$7.20/month)
 * Idle/stopped:    $0.0025/hour (~$1.80/month - snapshot storage)
 *
 * All amounts in USD.
 */

export const AGENT_PRICING = {
  // ── Hourly rates ──────────────────────────────────────────────────
  /** Cost per hour for a running agent. */
  RUNNING_HOURLY_RATE: 0.01,
  /** Cost per hour for an idle/stopped agent (snapshot storage). */
  IDLE_HOURLY_RATE: 0.0025,

  // ── Derived daily rates (for display / logging) ───────────────────
  /** Daily cost for a running agent ($0.24/day). */
  get DAILY_RUNNING_COST(): number {
    return Math.round(this.RUNNING_HOURLY_RATE * 24 * 100) / 100;
  },
  /** Daily cost for an idle agent ($0.06/day). */
  get DAILY_IDLE_COST(): number {
    return Math.round(this.IDLE_HOURLY_RATE * 24 * 100) / 100;
  },

  // ── Thresholds ────────────────────────────────────────────────────
  /** Minimum credit balance required before creating, provisioning, or resuming an agent. */
  MINIMUM_DEPOSIT: 0.1,
  /** Warn user when balance drops below this. */
  LOW_CREDIT_WARNING: 2.0,
  /** Hours between warning and forced shutdown. */
  GRACE_PERIOD_HOURS: 48,
} as const;
