import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { oauthService } from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import {
  type ManagedAgentGithubBinding,
  type ManagedAgentGithubMode,
  readManagedAgentGithubBinding,
  withManagedAgentGithubBinding,
  withoutManagedAgentGithubBinding,
} from "./eliza-agent-config";

export interface ManagedAgentGithubStatus {
  configured: boolean;
  connected: boolean;
  mode: ManagedAgentGithubMode | null;
  connectionId: string | null;
  connectionRole: "owner" | "agent" | null;
  githubUserId: string | null;
  githubUsername: string | null;
  githubDisplayName: string | null;
  githubAvatarUrl: string | null;
  githubEmail: string | null;
  scopes: string[];
  source: "platform_credentials" | "secrets" | null;
  adminElizaUserId: string | null;
  connectedAt: string | null;
}

function toStatus(
  agentConfig: Record<string, unknown> | null | undefined,
  configured: boolean,
): ManagedAgentGithubStatus {
  const binding = readManagedAgentGithubBinding(agentConfig);

  return {
    configured,
    connected: Boolean(binding),
    mode: binding?.mode ?? null,
    connectionId: binding?.connectionId ?? null,
    connectionRole: binding?.connectionRole ?? null,
    githubUserId: binding?.githubUserId ?? null,
    githubUsername: binding?.githubUsername ?? null,
    githubDisplayName: binding?.githubDisplayName ?? null,
    githubAvatarUrl: binding?.githubAvatarUrl ?? null,
    githubEmail: binding?.githubEmail ?? null,
    scopes: binding?.scopes ?? [],
    source: binding?.source ?? null,
    adminElizaUserId: binding?.adminElizaUserId ?? null,
    connectedAt: binding?.connectedAt ?? null,
  };
}

function isGithubOAuthConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

export class ManagedAgentGithubService {
  async getStatus(params: {
    agentId: string;
    organizationId: string;
  }): Promise<ManagedAgentGithubStatus | null> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      return null;
    }

    return toStatus(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
      isGithubOAuthConfigured(),
    );
  }

  async connectAgent(params: {
    agentId: string;
    organizationId: string;
    binding: ManagedAgentGithubBinding;
  }): Promise<{ restarted: boolean; status: ManagedAgentGithubStatus }> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      throw new Error("Agent not found");
    }

    const nextConfig = withManagedAgentGithubBinding(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
      params.binding,
    );

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

    logger.info("[managed-github] Linked GitHub to managed Eliza agent", {
      agentId: sandbox.id,
      organizationId: params.organizationId,
      githubUsername: params.binding.githubUsername,
      restarted,
    });

    return {
      restarted,
      status: toStatus(nextConfig, isGithubOAuthConfigured()),
    };
  }

  async disconnectAgent(params: {
    agentId: string;
    organizationId: string;
  }): Promise<{ restarted: boolean; status: ManagedAgentGithubStatus }> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      throw new Error("Agent not found");
    }

    const currentConfig = (sandbox.agent_config as Record<string, unknown> | null) ?? {};
    const currentBinding = readManagedAgentGithubBinding(currentConfig);

    // Revoke the OAuth connection if it exists
    if (currentBinding?.connectionId && currentBinding.mode !== "shared-owner") {
      try {
        await oauthService.revokeConnection({
          organizationId: params.organizationId,
          connectionId: currentBinding.connectionId,
        });
      } catch (error) {
        logger.warn("[managed-github] Failed to revoke OAuth connection during disconnect", {
          connectionId: currentBinding.connectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const nextConfig = withoutManagedAgentGithubBinding(currentConfig);

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

    logger.info("[managed-github] Unlinked GitHub from managed Eliza agent", {
      agentId: sandbox.id,
      organizationId: params.organizationId,
      restarted,
    });

    return {
      restarted,
      status: toStatus(nextConfig, isGithubOAuthConfigured()),
    };
  }

  /**
   * Get a valid GitHub access token for the agent's linked connection.
   * Auto-refreshes if needed (though GitHub OAuth App tokens don't expire).
   */
  async getAgentToken(params: {
    agentId: string;
    organizationId: string;
  }): Promise<{ accessToken: string; githubUsername: string } | null> {
    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      params.agentId,
      params.organizationId,
    );
    if (!sandbox) {
      return null;
    }

    const binding = readManagedAgentGithubBinding(
      (sandbox.agent_config as Record<string, unknown> | null) ?? {},
    );
    if (!binding) {
      return null;
    }

    const tokenResult = await oauthService.getValidToken({
      organizationId: params.organizationId,
      connectionId: binding.connectionId,
    });

    return {
      accessToken: tokenResult.accessToken,
      githubUsername: binding.githubUsername,
    };
  }
}

export const managedAgentGithubService = new ManagedAgentGithubService();
