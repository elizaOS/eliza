/**
 * Resolves read-only repeat-turn projections for personal Eliza messaging.
 * Only a fully converged canonical identity, lookup projection, and active
 * organization qualifies; every repair or creation case stays on the
 * sender-locked users repository path.
 */

import { sql } from "drizzle-orm";
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

/**
 * One indexed primary-database statement serves an established messaging turn.
 * The bounded target candidate avoids a second lookup for the normal one-user
 * organization; callers retain the exact source-marker lookup when another
 * personal target in the organization sorts ahead of this account's target.
 */
export async function findReusablePersonalDelivery(
  params:
    | {
        platform: "telegram";
        telegramId: string;
        telegramUsername?: string;
        telegramFirstName?: string;
      }
    | {
        platform: "discord";
        discordId: string;
        discordUsername: string;
        discordGlobalName?: string | null;
        discordAvatarUrl?: string | null;
      }
    | {
        platform: "phone";
        phoneNumber: string;
      },
): Promise<ReusablePersonalDelivery | null> {
  const canonicalIdentity =
    params.platform === "telegram"
      ? sql`
          canonical.telegram_id = ${params.telegramId}
          AND canonical.telegram_username IS NOT DISTINCT FROM projection.telegram_username
          AND canonical.telegram_first_name IS NOT DISTINCT FROM projection.telegram_first_name
          AND (
            ${params.telegramUsername ?? null}::text IS NULL
            OR canonical.telegram_username = ${params.telegramUsername ?? null}
          )
          AND (
            ${params.telegramFirstName ?? null}::text IS NULL
            OR canonical.telegram_first_name = ${params.telegramFirstName ?? null}
          )
        `
      : params.platform === "discord"
        ? sql`
          canonical.discord_id = ${params.discordId}
          AND canonical.discord_username IS NOT DISTINCT FROM projection.discord_username
          AND canonical.discord_global_name IS NOT DISTINCT FROM projection.discord_global_name
          AND canonical.discord_avatar_url IS NOT DISTINCT FROM projection.discord_avatar_url
          AND canonical.discord_username = ${params.discordUsername}
          AND (
            ${params.discordGlobalName === undefined}
            OR canonical.discord_global_name IS NOT DISTINCT FROM ${params.discordGlobalName ?? null}
          )
          AND (
            ${params.discordAvatarUrl === undefined}
            OR canonical.discord_avatar_url IS NOT DISTINCT FROM ${params.discordAvatarUrl ?? null}
          )
        `
        : sql`
          canonical.phone_number = ${params.phoneNumber}
          AND canonical.phone_verified = TRUE
          AND canonical.phone_number IS NOT DISTINCT FROM projection.phone_number
          AND projection.phone_verified = TRUE
        `;
  const projectedIdentity =
    params.platform === "telegram"
      ? sql`projection.telegram_id = ${params.telegramId}`
      : params.platform === "discord"
        ? sql`projection.discord_id = ${params.discordId}`
        : sql`projection.phone_number = ${params.phoneNumber}`;

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
        AND ${canonicalIdentity}
        AND canonical.steward_user_id = projection.steward_user_id
        AND canonical.is_anonymous = projection.is_anonymous
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
      WHERE ${projectedIdentity}
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
