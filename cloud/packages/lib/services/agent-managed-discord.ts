import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { logger } from "@/lib/utils/logger";
import {
  type ManagedAgentDiscordBinding,
  readManagedAgentDiscordBinding,
  readManagedAgentDiscordGateway,
  withManagedAgentDiscordBinding,
  withManagedAgentDiscordGateway,
  withoutManagedAgentDiscordBinding,
} from "./eliza-agent-config";

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

export class ManagedAgentDiscordService {
  async ensureGatewayAgent(params: { organizationId: string; userId: string }): Promise<{
    created: boolean;
    sandbox: Awaited<ReturnType<typeof agentSandboxesRepository.create>>;
  }> {
    const sandboxes = await agentSandboxesRepository.listByOrganization(params.organizationId);
    const existingGateway = sandboxes.find((sandbox) =>
      readManagedAgentDiscordGateway(
        (sandbox.agent_config as Record<string, unknown> | null) ?? {},
      ),
    );

    if (existingGateway) {
      return {
        created: false,
        sandbox: existingGateway,
      };
    }

    const sandbox = await agentSandboxesRepository.create({
      organization_id: params.organizationId,
      user_id: params.userId,
      agent_name: MANAGED_DISCORD_GATEWAY_AGENT_NAME,
      agent_config: withManagedAgentDiscordGateway({}),
      environment_vars: {},
      status: "pending",
      database_status: "none",
    });

    logger.info("[managed-discord] Created shared Discord gateway agent", {
      agentId: sandbox.id,
      organizationId: params.organizationId,
    });

    return {
      created: true,
      sandbox,
    };
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

    let restarted = false;
    if (sandbox.status === "running") {
      const shutdown = await elizaSandboxService.shutdown(sandbox.id, params.organizationId);
      if (!shutdown.success) {
        throw new Error(shutdown.error || "Failed to restart agent");
      }

      const provision = await elizaSandboxService.provision(sandbox.id, params.organizationId);
      if (!provision.success) {
        throw new Error(provision.error || "Failed to restart agent");
      }
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

    let restarted = false;
    if (sandbox.status === "running") {
      const shutdown = await elizaSandboxService.shutdown(sandbox.id, params.organizationId);
      if (!shutdown.success) {
        throw new Error(shutdown.error || "Failed to restart agent");
      }

      const provision = await elizaSandboxService.provision(sandbox.id, params.organizationId);
      if (!provision.success) {
        throw new Error(provision.error || "Failed to restart agent");
      }
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
