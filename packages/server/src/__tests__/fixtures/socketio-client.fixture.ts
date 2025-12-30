/**
 * SocketIOClientFixture - Manages Socket.IO client connections for testing
 *
 * Provides a clean interface for creating, managing, and cleaning up
 * Socket.IO client connections in integration tests.
 * Implements Symbol.asyncDispose for automatic cleanup.
 *
 * @example
 * ```typescript
 * describe('Socket.IO Tests', () => {
 *   it('should send messages', async () => {
 *     await using clientFixture = new SocketIOClientFixture(port);
 *     const client = await clientFixture.connect();
 *
 *     await clientFixture.joinChannel(channelId, entityId, messageServerId);
 *     await clientFixture.sendMessage({
 *       channelId,
 *       senderId,
 *       message: 'Hello!',
 *       messageServerId,
 *     });
 *
 *     // Auto-cleanup on scope exit!
 *   });
 * });
 * ```
 */

import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { SOCKET_MESSAGE_TYPE } from '@elizaos/core';
import type { UUID } from '@elizaos/core';

export interface SocketIOClientOptions {
  /** Transport methods to use */
  transports?: ('websocket' | 'polling')[];
  /** Auto-connect on creation */
  autoConnect?: boolean;
  /** Connection timeout in ms */
  timeout?: number;
  /** Entity ID for authentication */
  entityId?: UUID | string;
  /** API key for authentication */
  apiKey?: string;
}

export interface SendMessagePayload {
  channelId: UUID | string;
  senderId: UUID | string;
  senderName?: string;
  message: string;
  messageServerId: UUID | string;
  targetUserId?: UUID | string;
  attachments?: Array<{ url: string; type: string }>;
  metadata?: Record<string, unknown>;
}

export interface JoinChannelPayload {
  channelId: UUID | string;
  entityId?: UUID | string;
  messageServerId: UUID | string;
  metadata?: Record<string, unknown>;
}

/**
 * Socket.IO client fixture for integration testing
 */
export class SocketIOClientFixture {
  private port: number;
  private client: ClientSocket | null = null;
  private options: SocketIOClientOptions;
  private cleanupPerformed = false;

  constructor(port: number, options: SocketIOClientOptions = {}) {
    this.port = port;
    this.options = {
      transports: ['websocket'],
      autoConnect: false,
      timeout: 5000,
      ...options,
    };
  }

  /**
   * Create and connect a Socket.IO client
   */
  async connect(): Promise<ClientSocket> {
    if (this.client?.connected) {
      return this.client;
    }

    this.client = ioClient(`http://localhost:${this.port}`, {
      autoConnect: false,
      transports: this.options.transports,
      timeout: this.options.timeout,
      auth: {
        entityId: this.options.entityId,
        apiKey: this.options.apiKey,
      },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.options.timeout}ms`));
      }, this.options.timeout);

      this.client!.on('connection_established', () => {
        clearTimeout(timeout);
        resolve(this.client!);
      });

      this.client!.on('connect_error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.client!.connect();
    });
  }

  /**
   * Get the underlying Socket.IO client
   */
  getClient(): ClientSocket {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Check if the client is currently connected
   */
  isConnected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Join a channel
   */
  async joinChannel(payload: JoinChannelPayload): Promise<void> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Join channel timeout'));
      }, this.options.timeout);

      const errorHandler = (error: { error: string }) => {
        clearTimeout(timeout);
        this.client!.off('channel_joined', successHandler);
        this.client!.off('room_joined', successHandler);
        reject(new Error(error.error));
      };

      const successHandler = () => {
        clearTimeout(timeout);
        this.client!.off('messageError', errorHandler);
        resolve();
      };

      this.client!.once('channel_joined', successHandler);
      this.client!.once('room_joined', successHandler);
      this.client!.once('messageError', errorHandler);

      this.client!.emit(String(SOCKET_MESSAGE_TYPE.ROOM_JOINING), payload);
    });
  }

  /**
   * Send a message through Socket.IO
   */
  async sendMessage(payload: SendMessagePayload): Promise<{ status: string }> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Send message timeout'));
      }, this.options.timeout);

      const errorHandler = (error: { error: string }) => {
        clearTimeout(timeout);
        this.client!.off('messageAck', ackHandler);
        reject(new Error(error.error));
      };

      const ackHandler = (ack: { status: string }) => {
        clearTimeout(timeout);
        this.client!.off('messageError', errorHandler);
        resolve(ack);
      };

      this.client!.once('messageAck', ackHandler);
      this.client!.once('messageError', errorHandler);

      this.client!.emit(String(SOCKET_MESSAGE_TYPE.SEND_MESSAGE), {
        senderName: 'Test User',
        ...payload,
      });
    });
  }

  /**
   * Wait for a specific event
   */
  async waitForEvent<T = unknown>(eventName: string, timeoutMs?: number): Promise<T> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    const timeout = timeoutMs ?? this.options.timeout;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${eventName}`));
      }, timeout);

      this.client!.once(eventName, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  /**
   * Subscribe to log streaming
   */
  async subscribeToLogs(filters?: { agentName?: string; level?: string }): Promise<void> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Subscribe to logs timeout'));
      }, this.options.timeout);

      this.client!.once('log_subscription_confirmed', (data: { subscribed: boolean }) => {
        clearTimeout(timeout);
        if (data.subscribed) {
          if (filters) {
            this.client!.emit('update_log_filters', filters);
          }
          resolve();
        } else {
          reject(new Error('Subscription not confirmed'));
        }
      });

      this.client!.emit('subscribe_logs');
    });
  }

  /**
   * Unsubscribe from log streaming
   */
  async unsubscribeFromLogs(): Promise<void> {
    if (!this.client) {
      throw new Error('Client not connected. Call connect() first.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Unsubscribe from logs timeout'));
      }, this.options.timeout);

      this.client!.once('log_subscription_confirmed', (data: { subscribed: boolean }) => {
        clearTimeout(timeout);
        if (!data.subscribed) {
          resolve();
        } else {
          reject(new Error('Still subscribed'));
        }
      });

      this.client!.emit('unsubscribe_logs');
    });
  }

  /**
   * Disconnect the client
   */
  disconnect(): void {
    if (this.client) {
      this.client.removeAllListeners();
      if (this.client.connected) {
        this.client.disconnect();
      }
    }
  }

  /**
   * Clean up client resources
   */
  async cleanup(): Promise<void> {
    if (this.cleanupPerformed) {
      return;
    }

    try {
      this.disconnect();
    } finally {
      this.cleanupPerformed = true;
      this.client = null;
    }
  }

  /**
   * Symbol.asyncDispose implementation for automatic cleanup
   * Enables `await using` syntax
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }

  /**
   * Create multiple client fixtures
   */
  static createMany(
    port: number,
    count: number,
    options?: SocketIOClientOptions
  ): SocketIOClientFixture[] {
    return Array.from({ length: count }, () => new SocketIOClientFixture(port, options));
  }

  /**
   * Connect multiple clients in parallel
   */
  static async connectMany(fixtures: SocketIOClientFixture[]): Promise<ClientSocket[]> {
    return Promise.all(fixtures.map((f) => f.connect()));
  }

  /**
   * Cleanup multiple clients
   */
  static async cleanupMany(fixtures: SocketIOClientFixture[]): Promise<void> {
    await Promise.all(fixtures.map((f) => f.cleanup()));
  }
}
