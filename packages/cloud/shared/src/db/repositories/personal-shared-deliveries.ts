/**
 * Resolves read-only repeat-turn projections for trusted personal Eliza
 * deliveries. Only a fully converged canonical identity, lookup projection,
 * and active organization qualifies; every repair or creation case stays on
 * the provider-scoped users repository path.
 */

import { type SQL, sql } from "drizzle-orm";
import { AGENT_UPGRADED_FROM_KEY } from "../../lib/services/eliza-agent-config";
import { sqlRows } from "../execute-helpers";
import { dbWrite } from "../helpers";
import type { AgentSandboxStatus } from "../schemas/agent-sandboxes";
import { agentSandboxes } from "../schemas/agent-sandboxes";
import { organizations } from "../schemas/organizations";
import { userIdentities } from "../schemas/user-identities";
import { users } from "../schemas/users";

export interface ReusablePersonalDelivery {
  userId: string;
  organizationId: string;
  dedicatedCandidate: {
    id: string;
    status: AgentSandboxStatus;
    bridge_url: string | null;
    agent_config: Record<string, unknown> | null;
  } | null;
}

interface ReusablePersonalDeliveryRow {
  user_id: string;
  organization_id: string;
  dedicated_id: string | null;
  dedicated_status: AgentSandboxStatus | null;
  dedicated_bridge_url: string | null;
  dedicated_agent_config: Record<string, unknown> | null;
}

async function findReusablePersonalDelivery(params: {
  projectionMatch: SQL;
  canonicalIdentityMatch: SQL;
  incomingProfileMatch: SQL;
}): Promise<ReusablePersonalDelivery | null> {
  const [row] = await sqlRows<ReusablePersonalDeliveryRow>(
    dbWrite,
    sql`
      SELECT
        canonical.id AS user_id,
        organization.id AS organization_id,
        dedicated.id AS dedicated_id,
        dedicated.status AS dedicated_status,
        dedicated.bridge_url AS dedicated_bridge_url,
        dedicated.agent_config AS dedicated_agent_config
      FROM ${userIdentities} projection
      INNER JOIN ${users} canonical
        ON canonical.id = projection.user_id
        AND canonical.steward_user_id = projection.steward_user_id
        AND canonical.is_anonymous = projection.is_anonymous
        AND ${params.canonicalIdentityMatch}
        AND ${params.incomingProfileMatch}
      INNER JOIN ${organizations} organization
        ON organization.id = canonical.organization_id
        AND organization.is_active = TRUE
      LEFT JOIN LATERAL (
        SELECT
          candidate.id,
          candidate.status,
          candidate.bridge_url,
          candidate.agent_config
        FROM ${agentSandboxes} candidate
        WHERE candidate.organization_id = organization.id
          AND candidate.execution_tier = 'dedicated-always'
          AND candidate.agent_config ->> ${AGENT_UPGRADED_FROM_KEY} LIKE ${"personal:%"}
        ORDER BY candidate.created_at DESC
        LIMIT 1
      ) dedicated ON TRUE
      WHERE ${params.projectionMatch}
        AND canonical.deleted_at IS NULL
        AND canonical.is_active = TRUE
        AND canonical.organization_id IS NOT NULL
      LIMIT 1
    `,
  );

  if (!row) return null;
  if (!row.dedicated_id) {
    return {
      userId: row.user_id,
      organizationId: row.organization_id,
      dedicatedCandidate: null,
    };
  }
  if (!row.dedicated_status) {
    throw new Error(`Dedicated target ${row.dedicated_id} has no lifecycle status`);
  }
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    dedicatedCandidate: {
      id: row.dedicated_id,
      status: row.dedicated_status,
      bridge_url: row.dedicated_bridge_url,
      agent_config: row.dedicated_agent_config,
    },
  };
}

/**
 * One indexed primary-database statement serves an established Telegram turn.
 * The bounded target candidate avoids a second lookup for the normal one-user
 * organization; callers retain the exact source-marker lookup when another
 * personal target in the organization sorts ahead of this account's target.
 */
export function findReusableTelegramPersonalDelivery(params: {
  telegramId: string;
  telegramUsername?: string;
  telegramFirstName?: string;
}): Promise<ReusablePersonalDelivery | null> {
  return findReusablePersonalDelivery({
    projectionMatch: sql`projection.telegram_id = ${params.telegramId}`,
    canonicalIdentityMatch: sql`
      canonical.telegram_id = ${params.telegramId}
      AND canonical.telegram_username IS NOT DISTINCT FROM projection.telegram_username
      AND canonical.telegram_first_name IS NOT DISTINCT FROM projection.telegram_first_name
    `,
    incomingProfileMatch: sql`
      (${params.telegramUsername ?? null}::text IS NULL
        OR canonical.telegram_username = ${params.telegramUsername ?? null})
      AND (${params.telegramFirstName ?? null}::text IS NULL
        OR canonical.telegram_first_name = ${params.telegramFirstName ?? null})
    `,
  });
}

/**
 * Discord uses the same read-only delivery authority as Telegram while keeping
 * its independent provider identity columns. Omitted optional profile fields
 * are not interpreted as deletions; an explicit null must match durable state.
 */
export function findReusableDiscordPersonalDelivery(params: {
  discordId: string;
  discordUsername: string;
  discordGlobalName?: string | null;
  discordAvatarUrl?: string | null;
}): Promise<ReusablePersonalDelivery | null> {
  return findReusablePersonalDelivery({
    projectionMatch: sql`projection.discord_id = ${params.discordId}`,
    canonicalIdentityMatch: sql`
      canonical.discord_id = ${params.discordId}
      AND canonical.discord_username IS NOT DISTINCT FROM projection.discord_username
      AND canonical.discord_global_name IS NOT DISTINCT FROM projection.discord_global_name
      AND canonical.discord_avatar_url IS NOT DISTINCT FROM projection.discord_avatar_url
    `,
    incomingProfileMatch: sql`
      canonical.discord_username = ${params.discordUsername}
      AND (${params.discordGlobalName === undefined}::boolean
        OR canonical.discord_global_name IS NOT DISTINCT FROM ${params.discordGlobalName ?? null})
      AND (${params.discordAvatarUrl === undefined}::boolean
        OR canonical.discord_avatar_url IS NOT DISTINCT FROM ${params.discordAvatarUrl ?? null})
    `,
  });
}
