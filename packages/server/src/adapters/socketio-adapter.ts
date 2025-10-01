/**
 * Socket.io Adapter for MessageBusCore
 * Broadcasts messages to connected clients via Socket.io
 */

import type { Server as SocketIOServer } from 'socket.io';
import type { MessageBusAdapter, Message, BusControlMessage } from '@elizaos/core';

/**
 * Socket.io adapter that broadcasts messages to connected clients
 * Maintains backward compatibility with existing Socket.io infrastructure
 */
export class SocketIOAdapter implements MessageBusAdapter {
  name = 'socketio';

  constructor(private io: SocketIOServer) {}

  /**
   * Broadcast message to all connected clients in the channel
   */
  async onMessage(message: Message): Promise<void> {
    try {
      console.log(
        `[SocketIOAdapter] Broadcasting message ${message.id} from ${message.authorName} to channel ${message.channelId}`
      );

      const broadcastData = {
        id: message.id,
        senderId: message.authorId,
        senderName: message.authorName,
        text: message.content,
        channelId: message.channelId,
        roomId: message.channelId, // Backward compatibility
        serverId: message.serverId,
        createdAt: message.timestamp,
        source: message.source || 'message-bus',
        attachments: message.attachments,
        metadata: message.metadata,
        thought: message.metadata?.thought,
        actions: message.metadata?.actions,
        inReplyTo: message.inReplyTo,
      };

      // Broadcast to all clients in this channel
      // Format matches existing messageBroadcast event structure
      this.io.to(message.channelId).emit('messageBroadcast', broadcastData);

      console.log(`[SocketIOAdapter] Message broadcast complete for channel ${message.channelId}`);
    } catch (error) {
      console.error('[SocketIOAdapter] Error broadcasting message:', error);
    }
  }

  /**
   * Handle user joining a channel
   */
  async onJoin(_channelId: string, _userId: string): Promise<void> {
    // Socket.io room joining is handled separately by SocketIORouter
    // This is just a notification hook
  }

  /**
   * Handle user leaving a channel
   */
  async onLeave(_channelId: string, _userId: string): Promise<void> {
    // Socket.io room leaving is handled separately by SocketIORouter
    // This is just a notification hook
  }

  /**
   * Handle message deletion
   */
  async onDelete(messageId: string, channelId: string): Promise<void> {
    try {
      this.io.to(channelId).emit('messageDeleted', {
        messageId,
        channelId,
        roomId: channelId, // Backward compatibility
      });
    } catch (error) {
      console.error('[SocketIOAdapter] Error broadcasting deletion:', error);
    }
  }

  /**
   * Handle channel clearing
   */
  async onClear(channelId: string): Promise<void> {
    try {
      this.io.to(channelId).emit('channelCleared', {
        channelId,
        roomId: channelId, // Backward compatibility
      });
    } catch (error) {
      console.error('[SocketIOAdapter] Error broadcasting clear:', error);
    }
  }

  /**
   * Send a control message to clients
   * This is a custom method (not part of MessageBusAdapter interface)
   */
  async sendControl(control: BusControlMessage): Promise<void> {
    try {
      this.io.to(control.channelId).emit('controlMessage', {
        ...control,
        roomId: control.channelId, // Backward compatibility
      });
    } catch (error) {
      console.error('[SocketIOAdapter] Error sending control message:', error);
    }
  }
}
