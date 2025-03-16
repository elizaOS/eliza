import { logger, type IAgentRuntime, type UUID } from "@elizaos/core";
import { WebSocketService } from "./WebSocketService";

/**
 * Factory class for creating WebSocket service instances
 */
export class WebSocketFactory {
  private static instance: WebSocketFactory | null = null;
  private serverUrl: string;
  private services = new Map<string, WebSocketService>();
  
  /**
   * Get the singleton instance of the WebSocketFactory
   */
  public static getInstance(serverUrl?: string): WebSocketFactory {
    if (!WebSocketFactory.instance) {
      if (!serverUrl) {
        throw new Error("Server URL must be provided when creating WebSocketFactory");
      }
      WebSocketFactory.instance = new WebSocketFactory(serverUrl);
    }
    return WebSocketFactory.instance;
  }
  
  private constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
    logger.info(`[WebSocketFactory] Initialized with server URL: ${serverUrl}`);
  }
  
  /**
   * Create a new WebSocketService for a client
   */
  public createClientService(entityId: string, roomId: string): WebSocketService {
    const serviceKey = `client:${entityId}:${roomId}`;
    
    if (this.services.has(serviceKey)) {
      return this.services.get(serviceKey)!;
    }
    
    const service = new WebSocketService(this.serverUrl, entityId, roomId);
    this.services.set(serviceKey, service);
    
    return service;
  }
  
  /**
   * Create a new WebSocketService for an agent
   */
  public createAgentService(agentId: UUID, roomId: string, runtime: IAgentRuntime): WebSocketService {
    const serviceKey = `agent:${agentId}:${roomId}`;
    
    if (this.services.has(serviceKey)) {
      return this.services.get(serviceKey)!;
    }
    
    const service = new WebSocketService(this.serverUrl, agentId, roomId, runtime);
    this.services.set(serviceKey, service);
    
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
    logger.info("[WebSocketFactory] Closed all WebSocket connections");
  }
} 