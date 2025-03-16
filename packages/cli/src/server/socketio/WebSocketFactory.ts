import { logger, type IAgentRuntime, type UUID } from '@elizaos/core';
import { WebSocketService } from './WebSocketService';
import type { SocketIORouter } from '.';

/**
 * Factory class for creating WebSocket service instances
 */
export class WebSocketFactory {
  private static instances: Map<string, WebSocketFactory> = new Map();
  private services: Map<string, WebSocketService> = new Map();
  private serverUrl: string;
  private socketIORouter?: SocketIORouter;

  private constructor(serverUrl: string, router?: SocketIORouter) {
    this.serverUrl = serverUrl;
    this.socketIORouter = router;
    logger.info(`[WebSocketFactory] Initialized with serverUrl: ${serverUrl}`);
  }

  /**
   * Get a WebSocketFactory instance for the specified server URL
   */
  public static getInstance(serverUrl: string, router?: SocketIORouter): WebSocketFactory {
    if (!WebSocketFactory.instances.has(serverUrl)) {
      WebSocketFactory.instances.set(serverUrl, new WebSocketFactory(serverUrl, router));
    }
    return WebSocketFactory.instances.get(serverUrl)!;
  }

  /**
   * Get a service key for the given entity and room
   */
  private getServiceKey(entityId: string, roomId: string): string {
    return `agent:${entityId}:${roomId}`;
  }

  /**
   * Create a new WebSocketService for a client
   */
  public createClientService(entityId: string, roomId: string): WebSocketService {
    // Use the provided entityId - should already be the fixed zero ID
    const clientId = entityId;
    const serviceKey = `client:${clientId}:${roomId}`;

    if (this.services.has(serviceKey)) {
      logger.info(
        `[WebSocketFactory] Returning existing service for client ${clientId} in room ${roomId}`
      );
      return this.services.get(serviceKey)!;
    }

    logger.info(
      `[WebSocketFactory] Creating new WebSocketService for client ${clientId} in room ${roomId}`
    );
    const service = new WebSocketService(this.serverUrl, clientId, roomId);
    this.services.set(serviceKey, service);

    return service;
  }

  /**
   * Create a WebSocketService instance for an agent
   */
  public createAgentService(
    agentId: string,
    roomId: string,
    runtime: IAgentRuntime
  ): WebSocketService {
    const serviceKey = this.getServiceKey(agentId, roomId);

    // Use existing service if available
    if (this.services.has(serviceKey)) {
      logger.info(
        `[WebSocketFactory] Returning existing service for agent ${agentId} in room ${roomId}`
      );
      return this.services.get(serviceKey) as WebSocketService;
    }

    // Get the router instance
    const router = this.socketIORouter;
    if (!router) {
      logger.warn(
        `[WebSocketFactory] No SocketIORouter available, agent ${agentId} won't be registered`
      );
    } else {
      logger.info(`[WebSocketFactory] SocketIORouter is available for agent ${agentId}`);
    }

    // Create new WebSocketService
    logger.info(
      `[WebSocketFactory] Creating new WebSocketService for agent ${agentId} in room ${roomId}`
    );
    logger.info(`[WebSocketFactory] Using agentId as entityId to ensure proper message routing`);

    const service = new WebSocketService(
      this.serverUrl,
      agentId, // Use agentId as entityId for the agent's socket
      roomId,
      runtime,
      router
    );

    // Store service reference
    this.services.set(serviceKey, service);

    logger.info(
      `[WebSocketFactory] Successfully created WebSocketService for agent ${agentId} in room ${roomId}`
    );
    return service;
  }

  /**
   * Get a WebSocketService by entity ID and room ID
   */
  public getService(entityId: string, roomId: string): WebSocketService | undefined {
    // Try with client prefix first
    const clientKey = `client:${entityId}:${roomId}`;
    if (this.services.has(clientKey)) {
      return this.services.get(clientKey);
    }

    // Then try with agent prefix
    const agentKey = `agent:${entityId}:${roomId}`;
    return this.services.get(agentKey);
  }

  /**
   * Close and remove a WebSocketService
   */
  public removeService(entityId: string, roomId: string): boolean {
    const clientKey = `client:${entityId}:${roomId}`;
    const agentKey = `agent:${entityId}:${roomId}`;

    // Try to find the service with either key
    let service: WebSocketService | undefined;
    let serviceKey: string | undefined;

    if (this.services.has(clientKey)) {
      service = this.services.get(clientKey);
      serviceKey = clientKey;
    } else if (this.services.has(agentKey)) {
      service = this.services.get(agentKey);
      serviceKey = agentKey;
    }

    if (service && serviceKey) {
      service.disconnect();
      this.services.delete(serviceKey);
      return true;
    }

    return false;
  }

  /**
   * Close all WebSocketService instances
   */
  public closeAll(): void {
    for (const service of this.services.values()) {
      service.disconnect();
    }
    this.services.clear();
    logger.info('[WebSocketFactory] Closed all WebSocket connections');
  }
}
