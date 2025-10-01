/**
 * MessageBusCore - Pure JavaScript message bus
 * Works in any environment: browser, Node.js, Bun, Deno
 * No dependencies on database, server, or agent runtime
 */

import type {
  Message,
  MessageInput,
  MessageBusAdapter,
  BusControlMessage,
  MessageCallback,
  ControlCallback,
  UnsubscribeFunction,
} from './types';

/**
 * Core message bus for real-time messaging
 * Supports dependency injection via adapters
 */
export class MessageBusCore extends EventTarget {
  private adapters: MessageBusAdapter[] = [];
  private channelSubscribers = new Map<string, Set<MessageCallback>>();
  private controlSubscribers = new Set<ControlCallback>();
  private joinedChannels = new Set<string>();

  constructor() {
    super();
  }

  /**
   * Register an adapter (database, server, agent runtime, etc.)
   * Adapters are called in order when messages are sent
   *
   * @example
   * ```typescript
   * const bus = new MessageBusCore();
   * bus.use(new DatabaseAdapter());
   * bus.use(new SocketAdapter());
   * ```
   */
  use(adapter: MessageBusAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  /**
   * Send a message through the bus
   * The message will be:
   * 1. Given an ID and timestamp
   * 2. Passed to all registered adapters
   * 3. Emitted to local subscribers
   *
   * @param input - Message data (without ID and timestamp)
   * @returns The complete message with ID and timestamp
   *
   * @example
   * ```typescript
   * const message = await bus.send({
   *   channelId: 'channel-123',
   *   serverId: 'server-456',
   *   authorId: 'user-789',
   *   authorName: 'Alice',
   *   content: 'Hello world!',
   * });
   * ```
   */
  async send(input: MessageInput): Promise<Message> {
    const message: Message = {
      ...input,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    // Emit to local subscribers first (immediate UI feedback)
    this.emitToSubscribers(message);

    // Pass through all adapters in parallel
    await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onMessage?.(message);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter '${adapter.name}' failed:`, error);
        }
      })
    );

    return message;
  }

  /**
   * Subscribe to messages in a specific channel
   *
   * @param channelId - Channel to listen to
   * @param callback - Function called when messages arrive
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribe('channel-123', (msg) => {
   *   console.log('New message:', msg.content);
   * });
   *
   * // Later, stop listening
   * unsubscribe();
   * ```
   */
  subscribe(channelId: string, callback: MessageCallback): UnsubscribeFunction {
    if (!this.channelSubscribers.has(channelId)) {
      this.channelSubscribers.set(channelId, new Set());
    }

    this.channelSubscribers.get(channelId)!.add(callback);

    // Return unsubscribe function
    return () => {
      const subscribers = this.channelSubscribers.get(channelId);
      if (subscribers) {
        subscribers.delete(callback);
        // Clean up empty sets
        if (subscribers.size === 0) {
          this.channelSubscribers.delete(channelId);
        }
      }
    };
  }

  /**
   * Subscribe to control messages
   *
   * @param callback - Function called when control messages arrive
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = bus.subscribeControl((ctrl) => {
   *   if (ctrl.action === 'disable_input') {
   *     // Disable input field
   *   }
   * });
   * ```
   */
  subscribeControl(callback: ControlCallback): UnsubscribeFunction {
    this.controlSubscribers.add(callback);

    return () => {
      this.controlSubscribers.delete(callback);
    };
  }

  /**
   * Send a control message (for UI state management)
   *
   * @param control - Control message data
   *
   * @example
   * ```typescript
   * await bus.sendControl({
   *   action: 'disable_input',
   *   channelId: 'channel-123',
   *   target: 'message-input',
   * });
   * ```
   */
  async sendControl(control: BusControlMessage): Promise<void> {
    // Emit to control subscribers
    this.controlSubscribers.forEach((callback) => {
      try {
        callback(control);
      } catch (error) {
        console.error('[MessageBusCore] Control subscriber error:', error);
      }
    });

    // Also emit as CustomEvent for EventTarget-based listeners
    this.dispatchEvent(new CustomEvent('control', { detail: control }));
  }

  /**
   * Join a channel
   * Marks the channel as active and notifies adapters
   *
   * @param channelId - Channel to join
   * @param userId - User joining the channel
   *
   * @example
   * ```typescript
   * await bus.joinChannel('channel-123', 'user-456');
   * ```
   */
  async joinChannel(channelId: string, userId: string): Promise<void> {
    this.joinedChannels.add(channelId);

    // Notify adapters
    await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onJoin?.(channelId, userId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter '${adapter.name}' join failed:`, error);
        }
      })
    );
  }

  /**
   * Leave a channel
   * Marks the channel as inactive and notifies adapters
   *
   * @param channelId - Channel to leave
   * @param userId - User leaving the channel
   *
   * @example
   * ```typescript
   * await bus.leaveChannel('channel-123', 'user-456');
   * ```
   */
  async leaveChannel(channelId: string, userId: string): Promise<void> {
    this.joinedChannels.delete(channelId);

    // Notify adapters
    await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onLeave?.(channelId, userId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter '${adapter.name}' leave failed:`, error);
        }
      })
    );
  }

  /**
   * Delete a message
   *
   * @param messageId - ID of message to delete
   * @param channelId - Channel the message is in
   *
   * @example
   * ```typescript
   * await bus.deleteMessage('msg-123', 'channel-456');
   * ```
   */
  async deleteMessage(messageId: string, channelId: string): Promise<void> {
    // Notify adapters
    await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onDelete?.(messageId, channelId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter '${adapter.name}' delete failed:`, error);
        }
      })
    );

    // Emit event
    this.dispatchEvent(
      new CustomEvent('message_deleted', {
        detail: { messageId, channelId },
      })
    );
  }

  /**
   * Clear all messages in a channel
   *
   * @param channelId - Channel to clear
   *
   * @example
   * ```typescript
   * await bus.clearChannel('channel-123');
   * ```
   */
  async clearChannel(channelId: string): Promise<void> {
    // Notify adapters
    await Promise.allSettled(
      this.adapters.map(async (adapter) => {
        try {
          await adapter.onClear?.(channelId);
        } catch (error) {
          console.error(`[MessageBusCore] Adapter '${adapter.name}' clear failed:`, error);
        }
      })
    );

    // Emit event
    this.dispatchEvent(
      new CustomEvent('channel_cleared', {
        detail: { channelId },
      })
    );
  }

  /**
   * Check if a channel is currently joined
   *
   * @param channelId - Channel to check
   * @returns True if channel is joined
   */
  isChannelJoined(channelId: string): boolean {
    return this.joinedChannels.has(channelId);
  }

  /**
   * Get list of joined channels
   *
   * @returns Array of channel IDs
   */
  getJoinedChannels(): string[] {
    return Array.from(this.joinedChannels);
  }

  /**
   * Get number of subscribers for a channel
   *
   * @param channelId - Channel to check
   * @returns Number of subscribers
   */
  getSubscriberCount(channelId: string): number {
    return this.channelSubscribers.get(channelId)?.size ?? 0;
  }

  /**
   * Get all registered adapters
   *
   * @returns Array of adapters
   */
  getAdapters(): MessageBusAdapter[] {
    return [...this.adapters];
  }

  /**
   * Remove an adapter
   *
   * @param adapterName - Name of adapter to remove
   * @returns True if adapter was removed
   */
  removeAdapter(adapterName: string): boolean {
    const index = this.adapters.findIndex((a) => a.name === adapterName);
    if (index >= 0) {
      this.adapters.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all adapters
   */
  clearAdapters(): void {
    this.adapters = [];
  }

  /**
   * Emit message to local subscribers
   * @private
   */
  private emitToSubscribers(message: Message): void {
    const subscribers = this.channelSubscribers.get(message.channelId);
    if (subscribers) {
      subscribers.forEach((callback) => {
        try {
          callback(message);
        } catch (error) {
          console.error('[MessageBusCore] Subscriber callback error:', error);
        }
      });
    }

    // Also emit as CustomEvent for EventTarget-based listeners
    this.dispatchEvent(new CustomEvent('message', { detail: message }));
  }

  /**
   * Generate a unique message ID
   * Uses crypto.randomUUID if available, otherwise fallback
   * @private
   */
  private generateId(): string {
    // Use crypto.randomUUID if available (browser/Node 16+/Bun)
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    // Fallback for older environments
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}
