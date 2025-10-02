import type { IMessageTransport, Message } from '../types';
import type { UUID } from '../../types/primitives';

/**
 * WebSocket transport - works in browser AND server
 *
 * Provides real-time bi-directional communication with a message server.
 * Uses the standard WebSocket API which works in:
 * - Modern browsers
 * - Node.js (with ws package)
 * - Bun (native WebSocket support)
 * - Deno
 */
export class WebSocketTransport implements IMessageTransport {
  private ws?: WebSocket;
  private url: string;
  private subscriptions = new Map<UUID, Set<(message: Message) => void>>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second
  private reconnectTimer?: NodeJS.Timeout;

  constructor(url: string) {
    this.url = url;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          resolve();
        };

        this.ws.onerror = (error) => {
          reject(error);
        };

        this.ws.onmessage = (event) => {
          this.handleIncomingMessage(event);
        };

        this.ws.onclose = () => {
          this.handleDisconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  /**
   * Send a message through the WebSocket
   */
  async sendMessage(message: Message): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    this.ws.send(
      JSON.stringify({
        type: 'message',
        data: message,
      })
    );
  }

  /**
   * Subscribe to messages in a room
   */
  subscribe(roomId: UUID, callback: (message: Message) => void): void {
    if (!this.subscriptions.has(roomId)) {
      this.subscriptions.set(roomId, new Set());

      // Send subscription message to server
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: 'subscribe',
            roomId,
          })
        );
      }
    }
    this.subscriptions.get(roomId)!.add(callback);
  }

  /**
   * Unsubscribe from messages in a room
   */
  unsubscribe(roomId: UUID): void {
    this.subscriptions.delete(roomId);

    // Send unsubscribe message to server
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'unsubscribe',
          roomId,
        })
      );
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleIncomingMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);

      if (data.type === 'message') {
        const message = data.data as Message;
        const callbacks = this.subscriptions.get(message.roomId);
        if (callbacks) {
          callbacks.forEach((cb) => cb(message));
        }
      }
    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  /**
   * Handle WebSocket disconnection with reconnection logic
   */
  private handleDisconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

      console.log(
        `WebSocket disconnected. Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch((error) => {
          console.error('Reconnection failed:', error);
        });
      }, delay);
    } else {
      console.error('Max reconnection attempts reached. Please reconnect manually.');
    }
  }

  /**
   * Check if WebSocket is connected
   */
  isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }
}
