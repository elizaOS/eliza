import { type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import { FarcasterAgentManager } from "../managers/AgentManager";
import { FARCASTER_SERVICE_NAME } from "../types";
import { getFarcasterFid, hasFarcasterEnabled, validateFarcasterConfig } from "../utils/config";
import { FarcasterCastService } from "./CastService";
import { FarcasterMessageService } from "./MessageService";

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
    manager = new FarcasterAgentManager(runtime, farcasterConfig);
    service.managers.set(runtime.agentId, manager);

    const messageService = new FarcasterMessageService(manager.client, runtime);
    const castService = new FarcasterCastService(manager.client, runtime);

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
