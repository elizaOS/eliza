/**
 * Per-org ceiling on Cloud characters (the `/api/v1/app/agents` create path),
 * by credit tier, with an org-settings override. Extracted from that route so
 * the create-time enforcement and the read-only account-limits snapshot
 * (`GET /api/v1/billing/limits`) derive the ceiling from one canonical helper
 * and cannot drift (#19777). Tier thresholds deliberately mirror
 * `getMaxNonTerminalAgentsForOrg` in `agent-sandbox-quota.ts`.
 */

export const CLOUD_CHARACTER_LIMITS = {
  FREE_TIER: 5,
  STARTER: 20,
  PRO: 100,
  ENTERPRISE: 500,
} as const;

/**
 * The org's Cloud-character ceiling: an explicit positive
 * `org.settings.max_agents` override wins; otherwise the balance tier decides.
 */
export function getMaxCloudCharactersForOrg(
  creditBalance: number | undefined,
  orgSettings?: Record<string, unknown>,
): number {
  const customLimit = orgSettings?.max_agents as number | undefined;
  if (customLimit && customLimit > 0) return customLimit;

  const balance = Number(creditBalance ?? 0);
  if (balance >= 100.0) return CLOUD_CHARACTER_LIMITS.ENTERPRISE;
  if (balance >= 10.0) return CLOUD_CHARACTER_LIMITS.PRO;
  if (balance >= 1.0) return CLOUD_CHARACTER_LIMITS.STARTER;
  return CLOUD_CHARACTER_LIMITS.FREE_TIER;
}
