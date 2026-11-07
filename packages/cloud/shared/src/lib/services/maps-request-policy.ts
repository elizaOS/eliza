import type { InferenceCredentialCheck } from "./inference-credential-revocation";
/** P-56: separate Maps request allowance. Configuration contains no prices or monetary debits. */
export const MAPS_ALLOWANCE_ENV = "ELIZA_CLOUD_MAPS_REQUEST_ALLOWANCES";
export interface MapsRequestAllowance {
  requests: number;
  windowSeconds: number;
}
export function mapsRequestAllowance(
  env: Record<string, unknown>,
  planKey: string,
): MapsRequestAllowance | null {
  const raw = env[MAPS_ALLOWANCE_ENV];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw Error("Invalid Maps allowance configuration");
  const config = parsed as Record<string, unknown>;
  if (config.selected !== true) return null;
  if (!config.plans || typeof config.plans !== "object" || Array.isArray(config.plans))
    throw Error("Invalid Maps allowance plans");
  const plans = config.plans as Record<string, unknown>;
  if (!Object.hasOwn(plans, planKey)) return null;
  const value = plans[planKey];
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Maps allowance plan");
  const plan = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(plan.requests) ||
    Number(plan.requests) < 0 ||
    !Number.isSafeInteger(plan.windowSeconds) ||
    Number(plan.windowSeconds) < 1 ||
    Number(plan.windowSeconds) > 8_640_000_000_000
  )
    throw Error("Invalid Maps allowance bounds");
  return { requests: Number(plan.requests), windowSeconds: Number(plan.windowSeconds) };
}
export type MapsUsageOutcome = "succeeded" | "failed" | "cancelled";
export interface MapsAllowanceRequest {
  organizationId: string;
  requestId: string;
  credential: InferenceCredentialCheck & { organizationId: string };
  operation: "search" | "geocode" | "reverse" | "details" | "routes";
  policy: {
    generation: string;
    planKey: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    subscriptionFunded: boolean;
  };
}
