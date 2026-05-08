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
  normalizeFarcasterAccountId,
  resolveDefaultFarcasterAccountId,
  getFarcasterFid,
  hasFarcasterEnabled,
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
};

type RuntimeWithPostConnector = IAgentRuntime & {
  registerPostConnector?: (registration: FarcasterPostConnectorRegistration) => void;
};

export class FarcasterService extends Service {
  private static instance?: FarcasterService;
  private managers = new Map<UUID, FarcasterAgentManager>();
  private messageServices = new Map<UUID, FarcasterMessageService>();
  private castServices = new Map<UUID, FarcasterCastService>();

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
    let manager = service.managers.get(runtime.agentId);

    if (manager) {
      runtime.logger.warn({ agentId: runtime.agentId }, "Farcaster service already started");
      return service;
    }

    if (!hasFarcasterEnabled(runtime)) {
      runtime.logger.debug({ agentId: runtime.agentId }, "Farcaster service not enabled");
      return service;
    }

    const farcasterConfig = validateFarcasterConfig(runtime);
    const accountId = farcasterConfig.accountId;
    manager = new FarcasterAgentManager(runtime, farcasterConfig);
    service.managers.set(runtime.agentId, manager);

    const messageService = new FarcasterMessageService(manager.client, runtime, accountId);
    const castService = new FarcasterCastService(manager.client, runtime, accountId);

    service.messageServices.set(runtime.agentId, messageService);
    service.castServices.set(runtime.agentId, castService);

    await manager.start();

    runtime.logger.success({ agentId: runtime.agentId }, "Farcaster client started");
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = FarcasterService.getInstance();
    const manager = service.managers.get(runtime.agentId);
    if (manager) {
      await manager.stop();
      service.managers.delete(runtime.agentId);
      service.messageServices.delete(runtime.agentId);
      service.castServices.delete(runtime.agentId);
      runtime.logger.info({ agentId: runtime.agentId }, "Farcaster client stopped");
    } else {
      runtime.logger.debug({ agentId: runtime.agentId }, "Farcaster service not running");
    }
  }

  static registerSendHandlers(runtime: IAgentRuntime, serviceInstance: FarcasterService): void {
    const castService = serviceInstance?.getCastService(runtime.agentId);
    const accountId =
      castService?.getAccountId() ??
      normalizeFarcasterAccountId(resolveDefaultFarcasterAccountId(runtime));
    if (!castService) {
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

    runtime.logger.info(
      { src: "plugin:farcaster", agentId: runtime.agentId },
      "Registered Farcaster post connector"
    );
  }

  async stop(): Promise<void> {
    for (const manager of Array.from(this.managers.values())) {
      const agentId = manager.runtime.agentId;
      manager.runtime.logger.debug("Stopping Farcaster service");
      try {
        await FarcasterService.stop(manager.runtime);
      } catch (error) {
        manager.runtime.logger.error({ agentId, error }, "Error stopping Farcaster service");
      }
    }
  }

  getMessageService(agentId: UUID): FarcasterMessageService | undefined {
    return this.messageServices.get(agentId);
  }

  getCastService(agentId: UUID): FarcasterCastService | undefined {
    return this.castServices.get(agentId);
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    details: Record<string, unknown>;
  }> {
    const managerStatuses: Record<string, unknown> = {};
    let overallHealthy = true;

    for (const [agentId, manager] of Array.from(this.managers.entries())) {
      try {
        const fid = getFarcasterFid(manager.runtime);
        if (!fid) {
          throw new Error("FARCASTER_FID not configured");
        }
        const profile = await manager.client.getProfile(fid);
        managerStatuses[agentId] = {
          status: "healthy",
          fid: profile.fid,
          username: profile.username,
        };
      } catch (error) {
        managerStatuses[agentId] = {
          status: "unhealthy",
          error: error instanceof Error ? error.message : "Unknown error",
        };
        overallHealthy = false;
      }
    }

    return {
      healthy: overallHealthy,
      details: {
        activeManagers: this.managers.size,
        managerStatuses,
      },
    };
  }

  getActiveManagers(): Map<UUID, FarcasterAgentManager> {
    return new Map(this.managers);
  }
}
