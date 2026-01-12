import { type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import { RobloxClient } from "../client/RobloxClient";
import { type ManagerHealthStatus, ROBLOX_SERVICE_NAME, type RobloxConfig } from "../types";
import { hasRobloxEnabled, validateRobloxConfig } from "../utils/config";

class RobloxAgentManager {
  public runtime: IAgentRuntime;
  public client: RobloxClient;
  public config: RobloxConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;

  constructor(runtime: IAgentRuntime, config: RobloxConfig) {
    this.runtime = runtime;
    this.config = config;
    this.client = new RobloxClient(config);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.runtime.logger.info(
      { universeId: this.config.universeId },
      "Roblox agent manager started"
    );

    if (this.config.pollInterval > 0) {
      this.startPolling();
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.stopPolling();
    this.runtime.logger.info("Roblox agent manager stopped");
  }

  private startPolling(): void {
    if (this.pollTimer) {
      return;
    }

    const pollIntervalMs = this.config.pollInterval * 1000;
    this.pollTimer = setInterval(() => {
      this.poll().catch((error) => {
        this.runtime.logger.error({ error }, "Error during Roblox polling");
      });
    }, pollIntervalMs);

    this.runtime.logger.debug(
      { intervalSeconds: this.config.pollInterval },
      "Roblox polling started"
    );
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.runtime.logger.debug("Roblox polling stopped");
    }
  }

  private async poll(): Promise<void> {}

  async sendMessage(content: string, targetPlayerIds?: number[]): Promise<void> {
    await this.client.sendAgentMessage({
      topic: this.config.messagingTopic,
      data: {
        type: "agent_message",
        content,
        targetPlayerIds,
        timestamp: Date.now(),
      },
      sender: {
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
      },
    });
  }

  async executeAction(
    actionName: string,
    parameters: Record<string, string | number | boolean | null>,
    targetPlayerIds?: number[]
  ): Promise<void> {
    await this.client.sendAgentMessage({
      topic: this.config.messagingTopic,
      data: {
        type: "agent_action",
        action: actionName,
        parameters,
        targetPlayerIds,
        timestamp: Date.now(),
      },
      sender: {
        agentId: this.runtime.agentId,
        agentName: this.runtime.character.name,
      },
    });
  }
}

export class RobloxService extends Service {
  private static instance?: RobloxService;
  private managers = new Map<UUID, RobloxAgentManager>();

  static serviceType = ROBLOX_SERVICE_NAME;

  readonly description = "Roblox integration service for game communication";
  readonly capabilityDescription = "The agent can communicate with Roblox games and players";

  private static getInstance(): RobloxService {
    if (!RobloxService.instance) {
      RobloxService.instance = new RobloxService();
    }
    return RobloxService.instance;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    await RobloxService.start(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = RobloxService.getInstance();
    let manager = service.managers.get(runtime.agentId);

    if (manager) {
      runtime.logger.warn({ agentId: runtime.agentId }, "Roblox service already started");
      return service;
    }

    if (!hasRobloxEnabled(runtime)) {
      runtime.logger.debug(
        { agentId: runtime.agentId },
        "Roblox service not enabled - missing API key or Universe ID"
      );
      return service;
    }

    const robloxConfig = validateRobloxConfig(runtime);
    manager = new RobloxAgentManager(runtime, robloxConfig);
    service.managers.set(runtime.agentId, manager);

    await manager.start();

    runtime.logger.success(
      { agentId: runtime.agentId, universeId: robloxConfig.universeId },
      "Roblox service started"
    );
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = RobloxService.getInstance();
    const manager = service.managers.get(runtime.agentId);

    if (manager) {
      await manager.stop();
      service.managers.delete(runtime.agentId);
      runtime.logger.info({ agentId: runtime.agentId }, "Roblox service stopped");
    } else {
      runtime.logger.debug({ agentId: runtime.agentId }, "Roblox service not running");
    }
  }

  async stop(): Promise<void> {
    for (const manager of Array.from(this.managers.values())) {
      const agentId = manager.runtime.agentId;
      manager.runtime.logger.debug("Stopping Roblox service");
      try {
        await RobloxService.stop(manager.runtime);
      } catch (error) {
        manager.runtime.logger.error({ agentId, error }, "Error stopping Roblox service");
      }
    }
  }

  getManager(agentId: UUID): RobloxAgentManager | undefined {
    return this.managers.get(agentId);
  }

  getClient(agentId: UUID): RobloxClient | undefined {
    return this.managers.get(agentId)?.client;
  }

  async sendMessage(agentId: UUID, content: string, targetPlayerIds?: number[]): Promise<void> {
    const manager = this.managers.get(agentId);
    if (!manager) {
      throw new Error(`No Roblox manager found for agent ${agentId}`);
    }
    await manager.sendMessage(content, targetPlayerIds);
  }

  async executeAction(
    agentId: UUID,
    actionName: string,
    parameters: Record<string, string | number | boolean | null>,
    targetPlayerIds?: number[]
  ): Promise<void> {
    const manager = this.managers.get(agentId);
    if (!manager) {
      throw new Error(`No Roblox manager found for agent ${agentId}`);
    }
    await manager.executeAction(actionName, parameters, targetPlayerIds);
  }

  async healthCheck(): Promise<{
    healthy: boolean;
    details: {
      activeManagers: number;
      managerStatuses: Record<string, ManagerHealthStatus>;
    };
  }> {
    const managerStatuses: Record<string, ManagerHealthStatus> = {};
    let overallHealthy = true;

    for (const [agentId, manager] of Array.from(this.managers.entries())) {
      try {
        const experienceInfo = await manager.client.getExperienceInfo();
        managerStatuses[agentId] = {
          status: "healthy",
          universeId: manager.config.universeId,
          experienceName: experienceInfo.name,
          playing: experienceInfo.playing,
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

  getActiveManagers(): Map<UUID, RobloxAgentManager> {
    return new Map(this.managers);
  }
}
