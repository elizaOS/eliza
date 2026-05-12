import {
  ChannelType,
  type Content,
  type IAgentRuntime,
  type Memory,
  Service,
  type UUID,
} from "@elizaos/core";
import { FarcasterAgentManager } from "../managers/AgentManager";
import { FARCASTER_SERVICE_NAME } from "../types";
import {
  getFarcasterFid,
  hasFarcasterEnabled,
  listFarcasterAccountIds,
  normalizeFarcasterAccountId,
  resolveDefaultFarcasterAccountId,
  validateFarcasterConfig,
} from "../utils/config";
import { FarcasterCastService } from "./CastService";
import { FarcasterMessageService } from "./MessageService";

type FarcasterPostConnectorRegistration = {
  source: string;
  label?: string;
  description?: string;
  capabilities?: string[];
  contexts?: string[];
  metadata?: Record<string, unknown>;
  postHandler: (runtime: IAgentRuntime, content: Content) => Promise<Memory>;
  fetchFeed?: FarcasterCastService["fetchFeed"];
  searchPosts?: FarcasterCastService["searchPosts"];
  contentShaping?: {
    systemPromptFragment?: string;
    constraints?: Record<string, unknown>;
  };
  accountId?: string;
};

type RuntimeWithPostConnector = IAgentRuntime & {
  registerPostConnector?: (registration: FarcasterPostConnectorRegistration) => void;
};

interface AgentAccounts {
  defaultAccountId: string;
  managers: Map<string, FarcasterAgentManager>;
  messageServices: Map<string, FarcasterMessageService>;
  castServices: Map<string, FarcasterCastService>;
}

export class FarcasterService extends Service {
  private static instance?: FarcasterService;
  private agents = new Map<UUID, AgentAccounts>();

  static serviceType = FARCASTER_SERVICE_NAME;

  readonly description = "Farcaster integration service for sending and receiving casts";
  readonly capabilityDescription = "The agent is able to send and receive messages on farcaster";

  private static getInstance(): FarcasterService {
    if (!FarcasterService.instance) {
      FarcasterService.instance = new FarcasterService();
    }
    return FarcasterService.instance;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    await FarcasterService.start(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = FarcasterService.getInstance();
    if (service.agents.has(runtime.agentId)) {
      runtime.logger.warn({ agentId: runtime.agentId }, "Farcaster service already started");
      return service;
    }

    if (!hasFarcasterEnabled(runtime)) {
      runtime.logger.debug({ agentId: runtime.agentId }, "Farcaster service not enabled");
      return service;
    }

    const accounts: AgentAccounts = {
      defaultAccountId: normalizeFarcasterAccountId(resolveDefaultFarcasterAccountId(runtime)),
      managers: new Map(),
      messageServices: new Map(),
      castServices: new Map(),
    };
    service.agents.set(runtime.agentId, accounts);

    for (const accountId of listFarcasterAccountIds(runtime)) {
      if (!hasFarcasterEnabled(runtime, accountId)) {
        continue;
      }

      const farcasterConfig = validateFarcasterConfig(runtime, accountId);
      const manager = new FarcasterAgentManager(runtime, farcasterConfig);
      accounts.managers.set(accountId, manager);
      accounts.messageServices.set(
        accountId,
        new FarcasterMessageService(manager.client, runtime, accountId)
      );
      accounts.castServices.set(
        accountId,
        new FarcasterCastService(manager.client, runtime, accountId)
      );

      await manager.start();
      runtime.logger.success({ agentId: runtime.agentId, accountId }, "Farcaster client started");
    }

    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = FarcasterService.getInstance();
    const accounts = service.agents.get(runtime.agentId);
    if (accounts) {
      for (const manager of accounts.managers.values()) {
        await manager.stop();
      }
      service.agents.delete(runtime.agentId);
      runtime.logger.info({ agentId: runtime.agentId }, "Farcaster client stopped");
    } else {
      runtime.logger.debug({ agentId: runtime.agentId }, "Farcaster service not running");
    }
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: FarcasterService): void {
    const accounts = serviceInstance?.agents.get(runtime.agentId);
    if (!accounts || accounts.castServices.size === 0) {
      runtime.logger.warn(
        { src: "plugin:farcaster", agentId: runtime.agentId },
        "Cannot register Farcaster post connector; cast service is not initialized"
      );
      return;
    }

    const withPostConnector = runtime as RuntimeWithPostConnector;
    if (typeof withPostConnector.registerPostConnector !== "function") {
      return;
    }

    for (const castService of accounts.castServices.values()) {
      const accountId = castService.getAccountId();
      withPostConnector.registerPostConnector({
        source: "farcaster",
        accountId,
        label: "Farcaster",
        description:
          "Farcaster public cast connector for publishing casts and reading or searching the authenticated account's recent feed.",
        capabilities: ["post", "fetch_feed", "search_posts"],
        contexts: ["social", "social_posting", "connectors"],
        metadata: {
          accountId,
          service: FARCASTER_SERVICE_NAME,
        },
        postHandler: castService.handleSendPost.bind(castService),
        fetchFeed: castService.fetchFeed.bind(castService),
        searchPosts: castService.searchPosts.bind(castService),
        contentShaping: {
          systemPromptFragment:
            "For Farcaster casts, write a conversational public cast under 320 characters. If replying, keep enough context for a public thread.",
          constraints: {
            maxLength: 320,
            supportsMarkdown: false,
            channelType: ChannelType.FEED,
          },
        },
      });
    }

    runtime.logger.info(
      { src: "plugin:farcaster", agentId: runtime.agentId },
      "Registered Farcaster post connector"
    );
  }

  async stop(): Promise<void> {
    for (const [agentId, accounts] of Array.from(this.agents.entries())) {
      const runtime = accounts.managers.values().next().value?.runtime;
      runtime?.logger.debug("Stopping Farcaster service");
      try {
        if (runtime) {
          await FarcasterService.stop(runtime);
        } else {
          this.agents.delete(agentId);
        }
      } catch (error) {
        runtime?.logger.error({ agentId, error }, "Error stopping Farcaster service");
      }
    }
  }

  getMessageService(agentId: UUID, accountId?: string): FarcasterMessageService | undefined {
    return this.getMessageServiceForAccount(accountId, agentId);
  }

  getCastService(agentId: UUID, accountId?: string): FarcasterCastService | undefined {
    return this.getCastServiceForAccount(accountId, agentId);
  }

  getMessageServiceForAccount(
    accountId: string | undefined,
    agentId?: UUID
  ): FarcasterMessageService | undefined {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    if (!resolvedAgentId) return undefined;
    const accounts = this.agents.get(resolvedAgentId);
    if (!accounts) return undefined;
    const id = accountId ? normalizeFarcasterAccountId(accountId) : accounts.defaultAccountId;
    return accounts.messageServices.get(id);
  }

  getCastServiceForAccount(
    accountId: string | undefined,
    agentId?: UUID
  ): FarcasterCastService | undefined {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    if (!resolvedAgentId) return undefined;
    const accounts = this.agents.get(resolvedAgentId);
    if (!accounts) return undefined;
    const id = accountId ? normalizeFarcasterAccountId(accountId) : accounts.defaultAccountId;
    return accounts.castServices.get(id);
  }

  getManagerForAccount(
    accountId: string | undefined,
    agentId?: UUID
  ): FarcasterAgentManager | undefined {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    if (!resolvedAgentId) return undefined;
    const accounts = this.agents.get(resolvedAgentId);
    if (!accounts) return undefined;
    const id = accountId ? normalizeFarcasterAccountId(accountId) : accounts.defaultAccountId;
    return accounts.managers.get(id);
  }

  getDefaultAccountId(agentId?: UUID): string | undefined {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    return resolvedAgentId ? this.agents.get(resolvedAgentId)?.defaultAccountId : undefined;
  }

  listAccountIds(agentId?: UUID): string[] {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    const accounts = resolvedAgentId ? this.agents.get(resolvedAgentId) : undefined;
    return accounts ? Array.from(accounts.managers.keys()) : [];
  }

  getManagersForAgent(agentId?: UUID): Map<string, FarcasterAgentManager> {
    const resolvedAgentId = agentId ?? this.firstAgentId();
    const accounts = resolvedAgentId ? this.agents.get(resolvedAgentId) : undefined;
    return new Map(accounts?.managers ?? []);
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }> {
    const managerStatuses: Record<string, unknown> = {};
    let overallHealthy = true;

    for (const [agentId, accounts] of Array.from(this.agents.entries())) {
      managerStatuses[agentId] = {};
      for (const [accountId, manager] of Array.from(accounts.managers.entries())) {
        try {
          const fid = getFarcasterFid(manager.runtime, accountId);
          if (!fid) {
            throw new Error("FARCASTER_FID not configured");
          }
          const profile = await manager.client.getProfile(fid);
          (managerStatuses[agentId] as Record<string, unknown>)[accountId] = {
            status: "healthy",
            fid: profile.fid,
            username: profile.username,
          };
        } catch (error) {
          (managerStatuses[agentId] as Record<string, unknown>)[accountId] = {
            status: "unhealthy",
            error: error instanceof Error ? error.message : "Unknown error",
          };
          overallHealthy = false;
        }
      }
    }

    return {
      healthy: overallHealthy,
      details: {
        activeManagers: Array.from(this.agents.values()).reduce(
          (total, accounts) => total + accounts.managers.size,
          0
        ),
        managerStatuses,
      },
    };
  }

  getActiveManagers(): Map<string, FarcasterAgentManager> {
    return new Map(
      Array.from(this.agents.entries()).flatMap(([agentId, accounts]) =>
        Array.from(accounts.managers.entries()).map(
          ([accountId, manager]) => [`${agentId}:${accountId}`, manager] as const
        )
      )
    );
  }

  private firstAgentId(): UUID | undefined {
    return this.agents.keys().next().value;
  }
}
