import {
  type ConnectorAccount,
  DEFAULT_PRIVACY_LEVEL,
  getAccountPrivacy,
  getConnectorAccountManager,
  type IAgentRuntime,
  logger,
  type PrivacyLevel,
} from "@elizaos/core";

/**
 * The audience receiving content surfaced from a connector account.
 *
 * - `owner`: the account owner (always allowed by every privacy level).
 * - `team`: a team or admin role user.
 * - `agent_message_recipient`: any non-team participant addressing the agent.
 * - `public`: a broadcast surface (public posts, etc.).
 */
export type LifeOpsAudience =
  | "owner"
  | "team"
  | "agent_message_recipient"
  | "public";

/**
 * Returns true when an account at the given `privacy` level may be surfaced
 * to the given `audience`.
 *
 * Lattice:
 *   owner_only   -> owner
 *   team_visible -> owner | team
 *   semi_public  -> owner | team | agent_message_recipient
 *   public       -> any
 */
export function canSurfaceForAudience(
  privacy: PrivacyLevel,
  audience: LifeOpsAudience,
): boolean {
  if (audience === "owner") return true;
  switch (privacy) {
    case "owner_only":
      return false;
    case "team_visible":
      return audience === "team";
    case "semi_public":
      return audience === "team" || audience === "agent_message_recipient";
    case "public":
      return true;
    default:
      return false;
  }
}

export interface CanSurfaceAccountDataOptions {
  runtime: IAgentRuntime;
  provider: string;
  accountId: string;
  audience: LifeOpsAudience;
}

/**
 * Resolve a connector account and apply `canSurfaceForAudience` against the
 * stored privacy level. Returns false if the account cannot be loaded — the
 * caller must not surface the data.
 */
export async function canSurfaceAccountData(
  opts: CanSurfaceAccountDataOptions,
): Promise<boolean> {
  const provider = opts.provider.trim().toLowerCase();
  const accountId = opts.accountId.trim();
  if (!provider || !accountId) {
    return false;
  }
  const manager = getConnectorAccountManager(opts.runtime);
  const account = await manager.getAccount(provider, accountId);
  if (!account) {
    return false;
  }
  return canSurfaceForAudience(getAccountPrivacy(account), opts.audience);
}

/**
 * Filter a list of connector accounts down to those that may be surfaced to
 * the given audience. Logs a structured debug line indicating how many were
 * filtered out — does not log any account data.
 */
export function filterAccountsForAudience(
  accounts: readonly ConnectorAccount[],
  audience: LifeOpsAudience,
  context: { provider: string; runtime?: IAgentRuntime } = {
    provider: "unknown",
  },
): ConnectorAccount[] {
  const allowed: ConnectorAccount[] = [];
  let filtered = 0;
  for (const account of accounts) {
    const privacy = getAccountPrivacy(account);
    if (canSurfaceForAudience(privacy, audience)) {
      allowed.push(account);
    } else {
      filtered += 1;
    }
  }
  if (filtered > 0) {
    logger.debug(
      `[LifeOpsPrivacy] filtered ${filtered} accounts of provider ${context.provider} for audience ${audience}`,
    );
  }
  return allowed;
}

export const LIFEOPS_REDACTED_PLACEHOLDER = "[redacted: owner_only]";

/**
 * Choose the placeholder text for a redacted account when the privacy level
 * blocks surfacing to the audience.
 */
export function redactedPlaceholder(privacy: PrivacyLevel): string {
  return privacy === DEFAULT_PRIVACY_LEVEL
    ? LIFEOPS_REDACTED_PLACEHOLDER
    : `[redacted: ${privacy}]`;
}
