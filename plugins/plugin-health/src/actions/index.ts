/**
 * Health-related agent action surfaces exposed by plugin-health.
 *
 * The concrete runtime registration still happens in app-lifeops because the
 * umbrella action is owner-scoped and uses `LifeOpsService` for persistence.
 * Health-specific planning, parameters, metric formatting, and response data
 * shaping live here behind factories so host apps inject only access, service,
 * recent-conversation, and rendering adapters.
 */

export * from "./health.js";
export * from "./screen-time.js";

export const HEALTH_ACTION_SURFACES_EXTRACTED = true as const;
