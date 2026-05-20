/**
 * Messaging Provider
 * Provides access to chats and messages via A2A protocol
 *
 * A2A IS REQUIRED - These providers will not work without an active A2A connection
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from '@elizaos/core';
import { logger } from '../../../shared/logger';
import type { BabylonRuntime } from '../types';
// import type { A2AChatsResponse, A2AUnreadCountResponse, A2ANotificationsResponse } from '../../../types/a2a-responses' // Commented out - not needed

/**
 * Provider: Unread Messages
 * Gets agent's unread DMs and group chats via A2A
 */
export const messagesProvider: Provider = {
  name: 'BABYLON_MESSAGES',
  description: 'Get unread messages and recent chats via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const babylonRuntime = runtime as BabylonRuntime;

    // A2A is REQUIRED
    if (!babylonRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - messages provider requires A2A protocol',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot fetch messages. Please ensure A2A server is running.',
      };
    }

    // Define chat participant type
    interface ChatParticipant {
      id: string;
      username?: string;
      displayName?: string;
    }

    // Define chat type
    interface Chat {
      id: string;
      name: string | null;
      isGroup: boolean;
      participants: ChatParticipant[];
    }

    const [chatsResult, unreadResult] = await Promise.all([
      babylonRuntime.a2aClient.getChats(),
      babylonRuntime.a2aClient.getUnreadCount(),
    ]);

    const chatsData = chatsResult as { chats?: Chat[] };
    const unreadData = unreadResult as { unreadCount?: number };

    const chats = chatsData.chats || [];
    const unreadCount = unreadData.unreadCount || 0;

    const chatsText =
      chats.length > 0
        ? `Chats:\n${chats
            .map(
              (c) =>
                `- ${c.name || 'Unnamed'} (${c.isGroup ? 'Group' : 'DM'}) | ID: ${c.id} | Participants: ${c.participants?.length ?? 0}`
            )
            .join('\n')}`
        : 'No chats available.';

    return {
      text: `${chatsText}\n\nUnread messages: ${unreadCount}`,
    };
  },
};

/**
 * Provider: Notifications
 * Gets agent's recent notifications via A2A
 */
export const notificationsProvider: Provider = {
  name: 'BABYLON_NOTIFICATIONS',
  description: 'Get recent notifications via A2A protocol',

  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State
  ): Promise<ProviderResult> => {
    const babylonRuntime = runtime as BabylonRuntime;

    // A2A is REQUIRED
    if (!babylonRuntime.a2aClient?.isConnected()) {
      logger.error(
        'A2A client not connected - notifications provider requires A2A protocol',
        undefined,
        runtime.agentId
      );
      return {
        text: 'ERROR: A2A client not connected. Cannot fetch notifications. Please ensure A2A server is running.',
      };
    }

    try {
      const notificationsResult =
        await babylonRuntime.a2aClient.getNotifications(20);
      const notifications =
        (
          notificationsResult as {
            notifications?: Array<{
              id: string;
              type: string;
              message: string;
              read: boolean;
              createdAt: string | Date;
            }>;
          }
        )?.notifications || [];
      const unreadCount =
        (notificationsResult as { unreadCount?: number })?.unreadCount || 0;

      if (notifications.length === 0) {
        return { text: 'No notifications available.' };
      }

      const notificationsText = `Notifications (${unreadCount} unread):\n${notifications
        .map(
          (n, idx) =>
            `${idx + 1}. [${n.read ? 'READ' : 'UNREAD'}] ${n.type}: ${n.message} (ID: ${n.id})`
        )
        .join('\n\n')}`;

      return { text: notificationsText };
    } catch (error) {
      logger.error(
        'Error fetching notifications via A2A',
        { error, agentId: runtime.agentId },
        'NotificationsProvider'
      );
      throw error;
    }
  },
};
