// Coordinates cloud service agent managed discord behavior behind route handlers.
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { ensureAgentSandboxSchema } from "../../db/ensure-agent-sandbox-schema";
import { dbWrite } from "../../db/helpers";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { type AgentSandbox, agentSandboxes } from "../../db/schemas/agent-sandboxes";
import { organizations } from "../../db/schemas/organizations";
import { getMaxNonTerminalAgentsForOrg } from "../constants/agent-sandbox-quota";
import { logger } from "../utils/logger";
import {
  AGENT_MANAGED_DISCORD_GATEWAY_KEY,
  type ManagedAgentDiscordBinding,
  readManagedAgentDiscordBinding,
  withManagedAgentDiscordBinding,
  withManagedAgentDiscordGateway,
  withoutManagedAgentDiscordBinding,
} from "./eliza-agent-config";
import {
  configureElizaLifecycleTransaction,
  elizaAgentCreateAdvisoryLockSql,
} from "./eliza-provision-lock";
import { assertOrgAgentQuota } from "./eliza-sandbox";
import { provisioningJobService } from "./provisioning-jobs";

const DISCORD_OWNER_USER_IDS_ENV_KEY = "AGENT_DISCORD_OWNER_USER_IDS_JSON";
export const DISCORD_DEVELOPER_PORTAL_URL = "https://discord.com/developers/applications";
export const MANAGED_DISCORD_GATEWAY_AGENT_NAME = "Agent Discord Gateway";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = asRecord(parent[key]);
  if (existing) {
    return existing;
  }

  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function withDiscordConnectorAdmin(
  agentConfig: Record<string, unknown> | null | undefined,
  adminDiscordUserId: string,
): Record<string, unknown> {
  const next = { ...(agentConfig ?? {}) };
  const roles = ensureRecord(next, "roles");
  const connectorAdmins = ensureRecord(roles, "connectorAdmins");
  connectorAdmins.discord = [adminDiscordUserId];

  return next;
}

function withoutDiscordConnectorAdmin(
  agentConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(agentConfig ?? {}) };
  const roles = asRecord(next.roles);
  const connectorAdmins = asRecord(roles?.connectorAdmins);

  if (connectorAdmins) {
    delete connectorAdmins.discord;
    if (Object.keys(connectorAdmins).length === 0 && roles) {
      delete roles.connectorAdmins;
    }
  }

  if (roles && Object.keys(roles).length === 0) {
    delete next.roles;
  }

  return next;
}

function withDiscordOwnerIdentity(
  agentConfig: Record<string, unknown> | null | undefined,
  adminDiscordUserId: string,
): Record<string, unknown> {
  const next = { ...(agentConfig ?? {}) };
  const env = ensureRecord(next, "env");
  env[DISCORD_OWNER_USER_IDS_ENV_KEY] = JSON.stringify([adminDiscordUserId]);
  return next;
}

function withoutDiscordOwnerIdentity(
  agentConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const next = { ...(agentConfig ?? {}) };
  const env = asRecord(next.env);
  if (!env) {
    return next;
  }

  delete env[DISCORD_OWNER_USER_IDS_ENV_KEY];
  if (Object.keys(env).length === 0) {
    delete next.env;
  }
  return next;
}

export interface ManagedAgentDiscordStatus {
  applicationId: string | null;
  configured: boolean;
  connected: boolean;
  developerPortalUrl: string;
  guildId: string | null;
  guildName: string | null;
  adminDiscordUserId: string | null;
  adminDiscordUsername: string | null;
  adminDiscordDisplayName: string | null;
  adminDiscordAvatarUrl: string | null;
  adminElizaUserId: string | null;
  botNickname: string | null;
  connectedAt: string | null;
}

function toStatus(
  agentConfig: Record<string, unknown> | null | undefined,
  configured: boolean,
  applicationId: string | null,
): ManagedAgentDiscordStatus {
  const binding = readManagedAgentDiscordBinding(agentConfig);

  return {
    applicationId,
    configured,
    connected: Boolean(binding),
    developerPortalUrl: DISCORD_DEVELOPER_PORTAL_URL,
    guildId: binding?.guildId ?? null,
    guildName: binding?.guildName ?? null,
    adminDiscordUserId: binding?.adminDiscordUserId ?? null,
    adminDiscordUsername: binding?.adminDiscordUsername ?? null,
    adminDiscordDisplayName: binding?.adminDiscordDisplayName ?? null,
    adminDiscordAvatarUrl: binding?.adminDiscordAvatarUrl ?? null,
    adminElizaUserId: binding?.adminElizaUserId ?? null,
    botNickname: binding?.botNickname ?? null,
    connectedAt: binding?.connectedAt ?? null,
  };
}

/**
 * Execute the gateway marker recheck and quota admission under one caller-owned
 * primary transaction. Exported for a transaction-trace test; production
 * callers should use {@link ManagedAgentDiscordService.ensureGatewayAgent}.
 */
export async function ensureManagedDiscordGatewayInTransaction(
  tx: DbTransaction,
  params: { organizationId: string; userId: string },
): Promise<{ created: boolean; sandbox: AgentSandbox }> {
  await configureElizaLifecycleTransaction(tx);
  await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));

  // Resolve the tier from the primary inside the admission transaction.
  // Cache/replica reads can lag a balance decrease for minutes and admit a
  // gateway against a tier the organization no longer owns.
  const [organization] = await tx
    .select({ creditBalance: organizations.credit_balance })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  const creditBalance = Number.parseFloat(String(organization?.creditBalance ?? ""));
  const maxNonTerminalAgents = getMaxNonTerminalAgentsForOrg(creditBalance);

  // This MUST be a primary-DB marker recheck under the org lock. Filter to the
  // one logical gateway row: locking every sandbox in the organization couples
  // admission to unrelated lifecycle work and can exhaust the bounded timeout.
  const [existingGateway] = await tx
    .select()
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, params.organizationId),
        sql`${agentSandboxes.agent_config} -> ${AGENT_MANAGED_DISCORD_GATEWAY_KEY} ->> 'mode' = 'shared-gateway'`,
      ),
    )
    .orderBy(desc(agentSandboxes.created_at))
    .for("update")
    .limit(1);

  if (existingGateway) {
    return {
      created: false,
      sandbox: existingGateway,
    };
  }

  await assertOrgAgentQuota(tx, params.organizationId, maxNonTerminalAgents);

  const [sandbox] = await tx
    .insert(agentSandboxes)
    .values({
      organization_id: params.organizationId,
      user_id: params.userId,
      agent_name: MANAGED_DISCORD_GATEWAY_AGENT_NAME,
      agent_config: withManagedAgentDiscordGateway({}),
      environment_vars: {},
      // `pending` + non-pool is intentionally quota-counted. Keep this aligned
      // with QUOTA_COUNTED_STATUSES and account-limit snapshots.
      status: "pending",
      pool_status: null,
      database_status: "none",
    })
    .returning();
  if (!sandbox) {
    throw new Error("Failed to create managed Discord gateway agent");
  }

  return {
    created: true,
    sandbox,
  };
}

export class ManagedAgentDiscordService {
  /**
   * Return the org's shared Discord gateway, creating it atomically when absent.
   *
   * The gateway is deliberately a regular non-pool `pending` sandbox, so it
   * consumes one slot from the same resource-holding agent quota as every other
   * user-owned sandbox. The marker recheck, quota count, and insert all run
   * under the canonical per-org create lock; concurrent gateway retries and
   * sibling create routes therefore share one admission authority.
   */
  async ensureGatewayAgent(params: { organizationId: string; userId: string }): Promise<{
    created: boolean;
    sandbox: AgentSandbox;
  }> {
    // Preserve the repository create path's compatibility bootstrap before
    // moving the admission itself into a direct transaction.
    await ensureAgentSandboxSchema();

    const result = await dbWrite.transaction((tx) =>
      ensureManagedDiscordGatewayInTransaction(tx, params),
    );

    if (result.created) {
      logger.info("[managed-discord] Created shared Discord gateway agent", {
        agentId: result.sandbox.id,
        organizationId: params.organizationId,
      });
    }

    return result;
  }

  async getStatus(params: {
    agentId: string;
    organizationId: string;
    configured: boolean;
    applicationId: string | null;
  }): Promise<ManagedAgentDiscordStatus | null> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      return null;
    }

    return toStatus(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
      params.configured,
      params.applicationId,
    );
  }

  async connectAgent(params: {
    agentId: string;
    organizationId: string;
    binding: ManagedAgentDiscordBinding;
  }): Promise<{ restarted: boolean; status: ManagedAgentDiscordStatus }> {
    const conflictingGuildLinks = await agentSandboxesRepository.findByManagedDiscordGuildId(
      params.binding.guildId,
    );
    const conflict = conflictingGuildLinks.find((sandbox) => sandbox.id !== params.agentId);
    if (conflict) {
      throw new Error("Discord server is already linked to another agent");
    }

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      throw new Error("Agent not found");
    }

    let nextConfig = withManagedAgentDiscordBinding(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
      params.binding,
    );
    nextConfig = withDiscordConnectorAdmin(nextConfig, params.binding.adminDiscordUserId);
    nextConfig = withDiscordOwnerIdentity(nextConfig, params.binding.adminDiscordUserId);

    await agentSandboxesRepository.update(sandbox.id, {
      agent_config: nextConfig,
    });

    // Restart is asynchronous via the job queue (Workers can't SSH the
    // cores). `restarted: true` means a restart job was enqueued — the
    // daemon picks it up, stops the container, and re-provisions with
    // the freshly-persisted agent_config above.
    let restarted = false;
    if (sandbox.status === "running") {
      await provisioningJobService.enqueueAgentRestartOnce({
        agentId: sandbox.id,
        organizationId: params.organizationId,
        userId: sandbox.user_id,
      });
      // The restart job is already enqueued; triggerImmediate only nudges the
      // daemon to pick it up now. A failed nudge delays restart to the next poll.
      // error-policy:J7 nudge failure only delays an already-enqueued restart; logged, not fatal.
      void provisioningJobService.triggerImmediate().catch((err) =>
        logger.warn("[managed-discord] provisioning triggerImmediate nudge failed", {
          agentId: sandbox.id,
          organizationId: params.organizationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      restarted = true;
    }

    logger.info("[managed-discord] Linked Discord to managed Eliza agent", {
      agentId: sandbox.id,
      organizationId: params.organizationId,
      guildId: params.binding.guildId,
      adminDiscordUserId: params.binding.adminDiscordUserId,
      restarted,
    });

    return {
      restarted,
      status: toStatus(nextConfig, true, params.binding.applicationId ?? null),
    };
  }

  async disconnectAgent(params: {
    agentId: string;
    organizationId: string;
    configured: boolean;
    applicationId: string | null;
  }): Promise<{ restarted: boolean; status: ManagedAgentDiscordStatus }> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      throw new Error("Agent not found");
    }

    let nextConfig = withoutManagedAgentDiscordBinding(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
    );
    nextConfig = withoutDiscordConnectorAdmin(nextConfig);
    nextConfig = withoutDiscordOwnerIdentity(nextConfig);

    await agentSandboxesRepository.update(sandbox.id, {
      agent_config: nextConfig,
    });

    // Restart is asynchronous via the job queue (Workers can't SSH the
    // cores). `restarted: true` means a restart job was enqueued — the
    // daemon picks it up, stops the container, and re-provisions with
    // the freshly-persisted agent_config above.
    let restarted = false;
    if (sandbox.status === "running") {
      await provisioningJobService.enqueueAgentRestartOnce({
        agentId: sandbox.id,
        organizationId: params.organizationId,
        userId: sandbox.user_id,
      });
      // The restart job is already enqueued; triggerImmediate only nudges the
      // daemon to pick it up now. A failed nudge delays restart to the next poll.
      // error-policy:J7 nudge failure only delays an already-enqueued restart; logged, not fatal.
      void provisioningJobService.triggerImmediate().catch((err) =>
        logger.warn("[managed-discord] provisioning triggerImmediate nudge failed", {
          agentId: sandbox.id,
          organizationId: params.organizationId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      restarted = true;
    }

    logger.info("[managed-discord] Unlinked Discord from managed Eliza agent", {
      agentId: sandbox.id,
      organizationId: params.organizationId,
      restarted,
    });

    return {
      restarted,
      status: toStatus(nextConfig, params.configured, params.applicationId),
    };
  }
}

export const managedAgentDiscordService = new ManagedAgentDiscordService();
