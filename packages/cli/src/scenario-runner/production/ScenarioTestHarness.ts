import {
  type IAgentRuntime,
  type Memory,
  logger,
  type UUID,
  type Content,
  // type // Available if needed
  type HandlerCallback,
} from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';
export interface AgentResponse {
  id: UUID;
  timestamp: number;
  userId: UUID;
  agentId: UUID;
  roomId: UUID;
  content: Content;
  messageType: 'agent' | 'user';
}

export interface TestMessage {
  roomId: UUID;
  userId: UUID;
  content: {
    text: string;
    source?: string;
  };
}

export class ScenarioTestHarness {
  private runtime: IAgentRuntime;
  private responseQueue: AgentResponse[] = [];
  private waitingPromises: Map<
    string,
    { resolve: (response: AgentResponse) => void; reject: (error: Error) => void }
  > = new Map();
  private responseCallback: HandlerCallback;
  private lastResponsePromise: Promise<AgentResponse> | null = null;
  private lastResponseResolve: ((response: AgentResponse) => void) | null = null;
  private eventListeners: Map<string, Array<(data: any) => void>> = new Map();

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;

    // Create a callback that captures responses
    this.responseCallback = async (content: Content, _files?: any) => {
      const response: AgentResponse = {
        id: uuidv4() as UUID,
        timestamp: Date.now(),
        userId: this.runtime.agentId,
        agentId: this.runtime.agentId,
        roomId: (content.roomId as UUID) || (uuidv4() as UUID),
        content: content,
        messageType: 'agent',
      };

      this.responseQueue.push(response);
      this.emit('response', response);

      // Resolve any waiting promise
      if (this.lastResponseResolve) {
        this.lastResponseResolve(response);
        this.lastResponseResolve = null;
      }

      // Check if any promises are waiting for this type of response
      for (const [key, promise] of this.waitingPromises) {
        promise.resolve(response);
        this.waitingPromises.delete(key);
      }

      // Return empty array as required by HandlerCallback
      return [];
    };

    this.setupEventListeners();
  }

  private emit(event: string, data: any): void {
    const listeners = this.eventListeners.get(event) || [];
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        logger.error(`Error in event listener for ${event}:`, error);
      }
    }
  }

  private on(event: string, listener: (data: any) => void): void {
    const listeners = this.eventListeners.get(event) || [];
    listeners.push(listener);
    this.eventListeners.set(event, listeners);
  }

  private removeListener(event: string, listener: (data: any) => void): void {
    const listeners = this.eventListeners.get(event) || [];
    const filtered = listeners.filter((l) => l !== listener);
    if (filtered.length > 0) {
      this.eventListeners.set(event, filtered);
    } else {
      this.eventListeners.delete(event);
    }
  }

  private removeAllListeners(): void {
    this.eventListeners.clear();
  }

  private setupEventListeners(): void {
    // Register event handlers through the runtime's event system
    if (this.runtime.registerEvent) {
      this.runtime.registerEvent('message:sent', async (data: any) => {
        logger.debug('[TestHarness] Message sent event:', data);
      });

      this.runtime.registerEvent('action:executed', async (data: any) => {
        logger.debug('[TestHarness] Action executed:', data);
        this.emit('action:executed', data);
      });

      this.runtime.registerEvent('error', async (error: any) => {
        logger.error('[TestHarness] Runtime error:', error);
        this.emit('error', error);

        // Reject all waiting promises
        for (const [_key, promise] of this.waitingPromises) {
          promise.reject(error);
        }
        this.waitingPromises.clear();
      });
    }
  }

  async waitForAgentResponse(
    eventType: string = 'response',
    timeout: number = 30000
  ): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waitingPromises.delete(eventType);
        reject(new Error(`Timeout waiting for agent response (${timeout}ms)`));
      }, timeout);

      // Check if we already have a response in the queue
      if (this.responseQueue.length > 0) {
        const response = this.responseQueue.shift()!;
        clearTimeout(timer);
        resolve(response);
        return;
      }

      // Otherwise wait for the next response
      this.waitingPromises.set(eventType, {
        resolve: (response: AgentResponse) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async sendMessageAndWaitForResponse(
    message: string,
    roomId?: UUID,
    userId?: UUID
  ): Promise<AgentResponse> {
    const messageId = uuidv4() as UUID;
    const actualRoomId = roomId || (uuidv4() as UUID);
    const actualUserId = userId || (uuidv4() as UUID);

    // Create a promise that will be resolved when we get a response
    this.lastResponsePromise = new Promise<AgentResponse>((resolve) => {
      this.lastResponseResolve = resolve;
    });

    // Create a memory object
    const memory: Memory = {
      id: messageId,
      entityId: actualUserId,
      agentId: this.runtime.agentId,
      roomId: actualRoomId,
      content: {
        text: message,
        source: 'test',
      },
      createdAt: Date.now(),
    };

    // Process the message using the runtime's API
    logger.info(`[TestHarness] Sending message: "${message}"`);

    // First compose the state
    const state = await this.runtime.composeState(memory);

    // Then process actions with our callback
    await this.runtime.processActions(memory, [], state, this.responseCallback);

    // Also run evaluators
    await this.runtime.evaluate(memory, state, true, this.responseCallback, []);

    // Wait for the response with a timeout
    const timeoutPromise = new Promise<AgentResponse>((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout waiting for response (30s)`)), 30000);
    });

    try {
      return await Promise.race([this.lastResponsePromise, timeoutPromise]);
    } catch (error) {
      // If we timeout, check if there's a response in the queue
      if (this.responseQueue.length > 0) {
        return this.responseQueue.shift()!;
      }
      throw error;
    }
  }

  async waitForAction(actionName: string, timeout: number = 10000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('action:executed', handler);
        reject(new Error(`Timeout waiting for action ${actionName} (${timeout}ms)`));
      }, timeout);

      const handler = (data: any) => {
        if (data.action === actionName) {
          clearTimeout(timer);
          this.removeListener('action:executed', handler);
          resolve(data);
        }
      };

      this.on('action:executed', handler);
    });
  }

  async waitForMultipleResponses(count: number, timeout: number = 30000): Promise<AgentResponse[]> {
    const responses: AgentResponse[] = [];
    const startTime = Date.now();

    for (let i = 0; i < count; i++) {
      const remainingTime = timeout - (Date.now() - startTime);
      if (remainingTime <= 0) {
        throw new Error(`Timeout waiting for ${count} responses (got ${i})`);
      }

      const response = await this.waitForAgentResponse('response', remainingTime);
      responses.push(response);
    }

    return responses;
  }

  async sendBatchMessagesAndWaitForResponses(
    messages: string[],
    roomId?: UUID,
    userId?: UUID
  ): Promise<AgentResponse[]> {
    const responses: AgentResponse[] = [];

    for (const message of messages) {
      const response = await this.sendMessageAndWaitForResponse(message, roomId, userId);
      responses.push(response);
    }

    return responses;
  }

  clearResponseQueue(): void {
    this.responseQueue = [];
  }

  getResponseQueue(): AgentResponse[] {
    return [...this.responseQueue];
  }

  async waitForCondition(
    condition: () => boolean | Promise<boolean>,
    timeout: number = 10000,
    checkInterval: number = 100
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const result = await condition();
      if (result) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error('Timeout waiting for condition');
  }

  cleanup(): void {
    this.removeAllListeners();
    this.waitingPromises.clear();
    this.responseQueue = [];
    this.lastResponsePromise = null;
    this.lastResponseResolve = null;
  }
}
