// Sprint 4: venue-allowlist policy evaluator.
//
// Allows trades only on the named venues. Without a venue on the context
// (i.e. non-trade signing requests), the policy NACKs by default: this
// evaluator is opt-in per agent, so the absence of a venue means a
// trade-session caller forgot to set it, not that the request is benign.
// If you want the evaluator to soft-pass when venue is unset, leave the
// policy disabled or omit it from the agent's policy set.

import type {
  PolicyResult,
  PolicyRule,
  VenueAllowlistConfig,
} from "../../../shared/src/index.ts";

export interface VenueAllowlistContext {
  venue?: string;
}

export function evaluateVenueAllowlist(
  rule: PolicyRule,
  ctx: VenueAllowlistContext,
): PolicyResult {
  const config = rule.config as unknown as VenueAllowlistConfig;
  const base = { policyId: rule.id, type: rule.type } as const;

  const allowed = Array.isArray(config.allowedVenues)
    ? config.allowedVenues
    : [];
  if (allowed.length === 0) {
    return {
      ...base,
      passed: false,
      reason: "venue-allowlist: allowedVenues is empty (policy misconfigured)",
    };
  }

  if (!ctx.venue) {
    return {
      ...base,
      passed: false,
      reason: "venue-not-allowlisted: <missing venue in eval context>",
    };
  }

  if (allowed.includes(ctx.venue)) {
    return {
      ...base,
      passed: true,
      reason: `venue ${ctx.venue} allowlisted`,
    };
  }

  return {
    ...base,
    passed: false,
    reason: `venue-not-allowlisted: ${ctx.venue}`,
  };
}
