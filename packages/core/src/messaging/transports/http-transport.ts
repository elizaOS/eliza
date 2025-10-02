import type { IMessageTransport, Message } from '../types';
import type { UUID } from '../../types/primitives';

/**
 * HTTP transport with polling - fallback for environments without WebSocket
 *
 * Uses HTTP long-polling to simulate real-time communication. While not as
 * efficient as WebSocket, it works in restrictive network environments and
 * provides a reliable fallback option.
 */
export class HttpTransport implements IMessageTransport {
  private baseUrl: string;
  private pollingIntervals = new Map<UUID, NodeJS.Timeout>();
  private subscriptions = new Map<UUID, Set<(message: Message) => void>>();
  private pollInterval: number;
  private isConnected = false;

  constructor(baseUrl: string, pollInterval = 1000) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.pollInterval = pollInterval;
  }

  /**
   * Connect to the server (verify reachability)
   */
  async connect(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }
      this.isConnected = true;
    } catch (error) {
      throw new Error(
        `Failed to connect to server: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Disconnect and stop all polling
   */
  async disconnect(): Promise<void> {
    // Stop all polling intervals
    for (const interval of this.pollingIntervals.values()) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();
    this.isConnected = false;
  }

  /**
   * Send a message via HTTP POST
   */
  async sendMessage(message: Message): Promise<void> {
    if (!this.isConnected) {
      throw new Error('Not connected to server');
    }

    const response = await fetch(`${this.baseUrl}/rooms/${message.roomId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Subscribe to messages in a room (starts polling)
   */
  subscribe(roomId: UUID, callback: (message: Message) => void): void {
    if (!this.subscriptions.has(roomId)) {
      this.subscriptions.set(roomId, new Set());
      this.startPolling(roomId);
    }
    this.subscriptions.get(roomId)!.add(callback);
  }

  /**
   * Unsubscribe from messages in a room (stops polling)
   */
  unsubscribe(roomId: UUID): void {
    // Stop polling
    const interval = this.pollingIntervals.get(roomId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(roomId);
    }

    // Remove subscriptions
    this.subscriptions.delete(roomId);
  }

  /**
   * Start polling for new messages in a room
   */
  private startPolling(roomId: UUID): void {
    let lastMessageTime = Date.now();

    const poll = async () => {
      if (!this.isConnected) {
        return;
      }

      try {
        const response = await fetch(
          `${this.baseUrl}/rooms/${roomId}/messages?after=${lastMessageTime}&limit=50`
        );

        if (response.ok) {
          const data = await response.json();
          const messages = data.messages || data.data?.messages || [];

          messages.forEach((message: Message) => {
            const callbacks = this.subscriptions.get(roomId);
            if (callbacks) {
              callbacks.forEach((cb) => cb(message));
            }
            // Update last message time
            lastMessageTime = Math.max(lastMessageTime, message.createdAt);
          });
        } else if (response.status !== 404) {
          // 404 is ok (room might not exist yet), other errors should be logged
          console.error(`Polling error: ${response.status} ${response.statusText}`);
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    };

    // Start polling
    const interval = setInterval(poll, this.pollInterval);
    this.pollingIntervals.set(roomId, interval);

    // Poll immediately once
    poll();
  }

  /**
   * Change polling interval (useful for adaptive polling)
   */
  setPollInterval(interval: number): void {
    this.pollInterval = interval;

    // Restart all active polling with new interval
    const roomIds = Array.from(this.pollingIntervals.keys());
    roomIds.forEach((roomId) => {
      this.unsubscribe(roomId);
      const callbacks = this.subscriptions.get(roomId);
      if (callbacks) {
        this.startPolling(roomId);
      }
    });
  }

  /**
   * Get current polling interval
   */
  getPollInterval(): number {
    return this.pollInterval;
  }

  /**
   * Check if transport is connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }
}
