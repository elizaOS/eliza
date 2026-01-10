import type { TwitterAuth } from "./auth";

/**
 * Direct Message functionality is limited in Twitter API v2
 * Most DM features require additional OAuth permissions and are not available
 * in the standard API v2 endpoints used by this client
 */

/**
 * Represents a direct message object.
 * Note: This is a placeholder interface as Twitter API v2 has limited DM support
 */
export interface DirectMessage {
  id: string;
  text: string;
  senderId: string;
  recipientId: string;
  createdAt: string;
  mediaUrls?: string[];
  senderScreenName?: string;
  recipientScreenName?: string;
}

/**
 * Represents a direct message conversation.
 * Note: This is a placeholder interface as Twitter API v2 has limited DM support
 */
export interface DirectMessageConversation {
  conversationId: string;
  messages: DirectMessage[];
  participants: {
    id: string;
    screenName: string;
  }[];
}

/**
 * Represents a direct message event object.
 * Note: This is a placeholder interface as Twitter API v2 has limited DM support
 */
export interface DirectMessageEvent {
  id: string;
  type: string;
  message_create: {
    sender_id: string;
    target: {
      recipient_id: string;
    };
    message_data: {
      text: string;
      created_at: string;
      entities?: {
        urls?: Array<{
          url: string;
          expanded_url: string;
          display_url: string;
        }>;
        media?: Array<{
          url: string;
          type: string;
        }>;
      };
    };
  };
}

/**
 * Interface representing the response of direct messages.
 * Note: This is a placeholder interface as Twitter API v2 has limited DM support
 */
export interface DirectMessagesResponse {
  conversations: DirectMessageConversation[];
  users: TwitterUser[];
  cursor?: string;
  lastSeenEventId?: string;
  trustedLastSeenEventId?: string;
  untrustedLastSeenEventId?: string;
  inboxTimelines?: {
    trusted?: {
      status: string;
      minEntryId?: string;
    };
    untrusted?: {
      status: string;
      minEntryId?: string;
    };
  };
  userId: string;
}

/**
 * Interface representing a Twitter user.
 */
export interface TwitterUser {
  id: string;
  screenName: string;
  name: string;
  profileImageUrl: string;
  description?: string;
  verified?: boolean;
  protected?: boolean;
  followersCount?: number;
  friendsCount?: number;
}

/**
 * Interface representing the response of sending a direct message.
 * Note: This is a placeholder interface as Twitter API v2 has limited DM support
 */
export interface SendDirectMessageResponse {
  entries: {
    message: {
      id: string;
      time: string;
      affects_sort: boolean;
      conversation_id: string;
      message_data: {
        id: string;
        time: string;
        recipient_id: string;
        sender_id: string;
        text: string;
      };
    };
  }[];
  users: Record<string, TwitterUser>;
}

/**
 * Direct Message conversations are not supported in the current Twitter API v2 implementation
 * This functionality requires additional OAuth scopes and endpoints not included in this client
 *
 * @deprecated This function is not implemented for Twitter API v2
 */
export async function getDirectMessageConversations(
  userId: string,
  auth: TwitterAuth,
  cursor?: string,
): Promise<DirectMessagesResponse> {
  console.warn(
    "Direct message conversations are not supported in Twitter API v2 client",
  );
  return {
    conversations: [],
    users: [],
    userId,
  };
}

/**
 * Sending direct messages is not supported in the current Twitter API v2 implementation
 * This functionality requires additional OAuth scopes and endpoints not included in this client
 *
 * @deprecated This function is not implemented for Twitter API v2
 */
export async function sendDirectMessage(
  auth: TwitterAuth,
  conversation_id: string,
  text: string,
): Promise<SendDirectMessageResponse> {
  console.warn(
    "Sending direct messages is not supported in Twitter API v2 client",
  );
  throw new Error(
    "Direct message functionality not implemented for Twitter API v2",
  );
}
