import {
  Service,
  type IAgentRuntime,
  type ServiceTypeName,
  logger,
  type UUID,
} from '@elizaos/core';

/**
 * Integration bridge service for connecting with other plugins
 */
export class TodoIntegrationBridge extends Service {
  static serviceType: ServiceTypeName = 'TODO_INTEGRATION_BRIDGE' as ServiceTypeName;
  serviceName = 'TODO_INTEGRATION_BRIDGE' as ServiceTypeName;
  capabilityDescription = 'Bridges todo plugin with other plugins for enhanced functionality';

  static async start(runtime: IAgentRuntime): Promise<TodoIntegrationBridge> {
    logger.info('Starting TodoIntegrationBridge...');
    const service = new TodoIntegrationBridge();
    service.runtime = runtime;
    await service.initialize();
    logger.info('TodoIntegrationBridge started successfully');
    return service;
  }

  private async initialize(): Promise<void> {
    // Initialization complete
  }

  async stop(): Promise<void> {
    logger.info('TodoIntegrationBridge stopped');
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(TodoIntegrationBridge.serviceType);
    if (service) await service.stop();
  }
}
