/**
 * Per-org ceiling on Cloud characters (the `/api/v1/app/agents` create path),
 * by credit tier, with an org-settings override. Extracted from that route so
 * the create-time enforcement and the read-only account-limits snapshot
 * (`GET /api/v1/billing/limits`) derive the ceiling from one canonical helper
 * and cannot drift (#19777). Tier thresholds deliberately mirror
 * `getMaxNonTerminalAgentsForOrg` in `agent-sandbox-quota.ts`.
 */

import { ElizaError } from "@elizaos/core/edge";

export const CLOUD_CHARACTER_LIMITS = {
  FREE_TIER: 5,
  STARTER: 20,
  PRO: 100,
  ENTERPRISE: 500,
} as const;

export type CloudCharacterLimitSource =
  | "organization.settings.max_agents"
  | "organizations.credit_balance"
  | "default_free_tier";

export interface CloudCharacterLimitResolution {
  limit: number;
  source: CloudCharacterLimitSource;
}

function invalidCloudCharacterQuotaSource(source: string, message: string): ElizaError {
  return new ElizaError(message, {
    code: "INVALID_CLOUD_CHARACTER_QUOTA_SOURCE",
    context: { source },
    severity: "fatal",
  });
}

function readMaxAgentsOverride(orgSettings: unknown): number | undefined {
  if (orgSettings === undefined) return undefined;
  if (orgSettings === null || typeof orgSettings !== "object" || Array.isArray(orgSettings)) {
    throw invalidCloudCharacterQuotaSource(
      "organization.settings",
      "Cloud character quota settings must be a JSON object",
    );
  }

  const settings = orgSettings as Record<string, unknown>;
  if (!Object.hasOwn(settings, "max_agents")) return undefined;

  const value = settings.max_agents;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidCloudCharacterQuotaSource(
      "organization.settings.max_agents",
      "Cloud character quota override must be a positive safe integer",
    );
  }
  return value;
}

/** Resolve the character ceiling together with the authoritative source used. */
export function resolveMaxCloudCharactersForOrg(
  creditBalance: unknown,
  orgSettings?: unknown,
): CloudCharacterLimitResolution {
  if (
    creditBalance !== undefined &&
    (typeof creditBalance !== "number" || !Number.isFinite(creditBalance))
  ) {
    throw invalidCloudCharacterQuotaSource(
      "organizations.credit_balance",
      "Cloud character quota credit balance must be a finite number",
    );
  }

  const customLimit = readMaxAgentsOverride(orgSettings);
  if (customLimit !== undefined) {
    return { limit: customLimit, source: "organization.settings.max_agents" };
  }

  if (creditBalance === undefined) {
    return { limit: CLOUD_CHARACTER_LIMITS.FREE_TIER, source: "default_free_tier" };
  }

  if (creditBalance >= 100.0) {
    return {
      limit: CLOUD_CHARACTER_LIMITS.ENTERPRISE,
      source: "organizations.credit_balance",
    };
  }
  if (creditBalance >= 10.0) {
    return { limit: CLOUD_CHARACTER_LIMITS.PRO, source: "organizations.credit_balance" };
  }
  if (creditBalance >= 1.0) {
    return { limit: CLOUD_CHARACTER_LIMITS.STARTER, source: "organizations.credit_balance" };
  }
  return { limit: CLOUD_CHARACTER_LIMITS.FREE_TIER, source: "organizations.credit_balance" };
}

/**
 * The org's Cloud-character ceiling: an explicit positive
 * `org.settings.max_agents` override wins; otherwise the balance tier decides.
 */
export function getMaxCloudCharactersForOrg(creditBalance: unknown, orgSettings?: unknown): number {
  return resolveMaxCloudCharactersForOrg(creditBalance, orgSettings).limit;
}
