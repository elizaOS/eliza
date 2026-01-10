import { logger, Service, UUID, type IAgentRuntime, ServiceType } from '@elizaos/core';
import { BLUESKY_SERVICE_NAME } from './common/constants.js';
import { BlueSkyAgentManager } from './managers/agent.js';
import { hasBlueSkyEnabled, validateBlueSkyConfig } from './common/config.js';
import { BlueSkyMessageService } from './services/MessageService.js';
import { BlueSkyPostService } from './services/PostService.js';
import { BlueSkyClient } from './client.js';

export class BlueSkyService extends Service {
  private static instance?: BlueSkyService;
  private managers = new Map<UUID, BlueSkyAgentManager>();
  private messageServices = new Map<UUID, BlueSkyMessageService>();
  private postServices = new Map<UUID, BlueSkyPostService>();
  static serviceType: string = BLUESKY_SERVICE_NAME;
  readonly capabilityDescription = 'The agent is able to send and receive messages on BlueSky';

  private static getInstance(): BlueSkyService {
    if (!BlueSkyService.instance) {
      BlueSkyService.instance = new BlueSkyService();
    }
    return BlueSkyService.instance;
  }

  // For testing purposes - clear the singleton instance
  static clearInstance(): void {
    BlueSkyService.instance = undefined;
  }

  // Called to start a single BlueSky service
  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = BlueSkyService.getInstance();
    let manager = service.managers.get(runtime.agentId);

    if (manager) {
      logger.warn('BlueSky service already started', runtime.agentId);
      return service;
    }

    if (!hasBlueSkyEnabled(runtime)) {
      logger.debug('BlueSky service not enabled', runtime.agentId);
      return service;
    }

    const blueSkyConfig = validateBlueSkyConfig(runtime);

    // Create BlueSky client
    const client = new BlueSkyClient({
      service: blueSkyConfig.service || 'https://bsky.social',
      handle: blueSkyConfig.handle,
      password: blueSkyConfig.password,
      dryRun: blueSkyConfig.dryRun,
    });

    manager = new BlueSkyAgentManager(runtime, blueSkyConfig, client);
    service.managers.set(runtime.agentId, manager);

    // Create and store MessageService and PostService instances
    const messageService = new BlueSkyMessageService(client, runtime);
    const postService = new BlueSkyPostService(client, runtime);

    service.messageServices.set(runtime.agentId, messageService);
    service.postServices.set(runtime.agentId, postService);

    try {
      await manager.start();
      logger.success('BlueSky client started', runtime.agentId);
    } catch (error) {
      logger.error('Failed to start BlueSky manager', { agentId: runtime.agentId, error });
      // Service is still created but manager failed to start
    }

    return service;
  }

  // Called to stop a single BlueSky service
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = BlueSkyService.getInstance();
    let manager = service.managers.get(runtime.agentId);
    if (manager) {
      await manager.stop();
      service.managers.delete(runtime.agentId);
      service.messageServices.delete(runtime.agentId);
      service.postServices.delete(runtime.agentId);
      logger.info('BlueSky client stopped', runtime.agentId);
    } else {
      logger.debug('BlueSky service not running', runtime.agentId);
    }
  }

  // Called to stop all BlueSky services
  async stop(): Promise<void> {
    logger.debug('Stopping ALL BlueSky services');
    for (const manager of Array.from(this.managers.values())) {
      const agentId = manager.runtime.agentId;
      try {
        await BlueSkyService.stop(manager.runtime);
      } catch (error) {
        logger.error('Error stopping BlueSky service', agentId, error);
      }
    }
  }

  // Get the MessageService for a specific agent
  getMessageService(agentId: UUID): BlueSkyMessageService | undefined {
    return this.messageServices.get(agentId);
  }

  // Get the PostService for a specific agent
  getPostService(agentId: UUID): BlueSkyPostService | undefined {
    return this.postServices.get(agentId);
  }
}
