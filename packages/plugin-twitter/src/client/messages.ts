import type { TwitterAuth } from './auth';
import { updateCookieJar } from './requests';

/**
 * Represents a direct message object.
 * @typedef {Object} DirectMessage
 * @property {string} id - The unique identifier of the direct message.
 * @property {string} text - The text content of the direct message.
 * @property {string} senderId - The unique identifier of the sender of the direct message.
 * @property {string} recipientId - The unique identifier of the recipient of the direct message.
 * @property {string} createdAt - The timestamp when the direct message was created.
 * @property {string[]} [mediaUrls] - An optional array of URLs for any media included in the direct message.
 * @property {string} [senderScreenName] - The screen name of the sender of the direct message.
 * @property {string} [recipientScreenName] - The screen name of the recipient of the direct message.
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
 * @typedef {Object} DirectMessageConversation
 * @property {string} conversationId - The ID of the conversation.
 * @property {DirectMessage[]} messages - An array of DirectMessage objects representing the messages in the conversation.
 * @property {Object[]} participants - An array of participant objects with IDs and screen names.
 * @property {string} participants.id - The ID of the participant.
 * @property {string} participants.screenName - The screen name of the participant.
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
 * @typedef {Object} DirectMessageEvent
 * @property {string} id - The unique identifier of the direct message event.
 * @property {string} type - The type of the direct message event.
 * @property {Object} message_create - Object containing information about the message creation.
 * @property {string} message_create.sender_id - The sender's unique identifier.
 * @property {Object} message_create.target - Object containing information about the message target user.
 * @property {string} message_create.target.recipient_id - The recipient's unique identifier.
 * @property {Object} message_create.message_data - Object containing the message data.
 * @property {string} message_create.message_data.text - The text content of the message.
 * @property {string} message_create.message_data.created_at - The timestamp when the message was created.
 * @property {Object} [message_create.message_data.entities] - Object containing optional entities in the message data.
 * @property {Array<Object>} [message_create.message_data.entities.urls] - Array of URL objects in the message data.
 * @property {string} message_create.message_data.entities.urls.url - The URL in the message.
 * @property {string} message_create.message_data.entities.urls.expanded_url - The expanded URL of the link in the message.
 * @property {string} message_create.message_data.entities.urls.display_url - The display URL of the link in the message.
 * @property {Array<Object>} [message_create.message_data.entities.media] - Array of media objects in the message data.
 * @property {string} message_create.message_data.entities.media.url - The URL of the media in the message.
 * @property {string} message_create.message_data.entities.media.type - The type of media in the message.
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
 * @typedef {Object} DirectMessagesResponse
 * @property {DirectMessageConversation[]} conversations - Array of direct message conversations.
 * @property {TwitterUser[]} users - Array of Twitter users.
 * @property {string} [cursor] - Optional cursor for pagination.
 * @property {string} [lastSeenEventId] - Optional ID of the last seen event.
 * @property {string} [trustedLastSeenEventId] - Optional ID of the last seen trusted event.
 * @property {string} [untrustedLastSeenEventId] - Optional ID of the last seen untrusted event.
 * @property {Object} [inboxTimelines] - Optional object containing trusted and untrusted inbox timelines.
 * @property {Object} [inboxTimelines.trusted] - Object containing status and optional minimum entry ID for trusted inbox timeline.
 * @property {string} inboxTimelines.trusted.status - Status of the trusted inbox timeline.
 * @property {string} [inboxTimelines.trusted.minEntryId] - Optional minimum entry ID for the trusted inbox timeline.
 * @property {Object} [inboxTimelines.untrusted] - Object containing status and optional minimum entry ID for untrusted inbox timeline.
 * @property {string} inboxTimelines.untrusted.status - Status of the untrusted inbox timeline.
 * @property {string} [inboxTimelines.untrusted.minEntryId] - Optional minimum entry ID for the untrusted inbox timeline.
 * @property {string} userId - ID of the user.
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
 * @property {string} id - The unique identifier of the user.
 * @property {string} screenName - The user's screen name.
 * @property {string} name - The user's full name.
 * @property {string} profileImageUrl - The URL of the user's profile image.
 * @property {string} [description] - The user's profile description.
 * @property {boolean} [verified] - Whether the user is a verified account.
 * @property {boolean} [protected] - Whether the user has a protected account.
 * @property {number} [followersCount] - The number of followers the user has.
 * @property {number} [friendsCount] - The number of friends the user has.
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
 * @typedef {Object} SendDirectMessageResponse
 * @property {Array<{message: {id: string, time: string, affects_sort: boolean, conversation_id: string, message_data: {id: string, time: string, recipient_id: string, sender_id: string, text: string}}}>} entries - Array of message entries.
 * @property {Object.<string, TwitterUser>} users - Record of Twitter users.
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
 * Parses direct message conversations from the provided data.
 * @param {any} data - The data containing direct message conversations.
 * @param {string} userId - The user ID for which the conversations should be parsed.
 * @returns {DirectMessagesResponse} The parsed direct message conversations.
 */
function parseDirectMessageConversations(data: any, userId: string): DirectMessagesResponse {
  try {
    const inboxState = data?.inbox_initial_state;
    const conversations = inboxState?.conversations || {};
    const entries = inboxState?.entries || [];
    const users = inboxState?.users || {};

    // Parse users first
    const parsedUsers: TwitterUser[] = Object.values(users).map((user: any) => ({
      id: user.id_str,
      screenName: user.screen_name,
      name: user.name,
      profileImageUrl: user.profile_image_url_https,
      description: user.description,
      verified: user.verified,
      protected: user.protected,
      followersCount: user.followers_count,
      friendsCount: user.friends_count,
    }));

    // Group messages by conversation_id
    const messagesByConversation: Record<string, any[]> = {};
    entries.forEach((entry: any) => {
      if (entry.message) {
        const convId = entry.message.conversation_id;
        if (!messagesByConversation[convId]) {
          messagesByConversation[convId] = [];
        }
        messagesByConversation[convId].push(entry.message);
      }
    });

    // Convert to DirectMessageConversation array
    const parsedConversations = Object.entries(conversations).map(
      ([convId, conv]: [string, any]) => {
        const messages = messagesByConversation[convId] || [];

        // Sort messages by time in ascending order
        messages.sort((a, b) => Number(a.time) - Number(b.time));

        return {
          conversationId: convId,
          messages: parseDirectMessages(messages, users),
          participants: conv.participants.map((p: any) => ({
            id: p.user_id,
            screenName: users[p.user_id]?.screen_name || p.user_id,
          })),
        };
      }
    );

    return {
      conversations: parsedConversations,
      users: parsedUsers,
      cursor: inboxState?.cursor,
      lastSeenEventId: inboxState?.last_seen_event_id,
      trustedLastSeenEventId: inboxState?.trusted_last_seen_event_id,
      untrustedLastSeenEventId: inboxState?.untrusted_last_seen_event_id,
      inboxTimelines: {
        trusted: inboxState?.inbox_timelines?.trusted && {
          status: inboxState.inbox_timelines.trusted.status,
          minEntryId: inboxState.inbox_timelines.trusted.min_entry_id,
        },
        untrusted: inboxState?.inbox_timelines?.untrusted && {
          status: inboxState.inbox_timelines.untrusted.status,
          minEntryId: inboxState.inbox_timelines.untrusted.min_entry_id,
        },
      },
      userId,
    };
  } catch (error) {
    console.error('Error parsing DM conversations:', error);
    return {
      conversations: [],
      users: [],
      userId,
    };
  }
}

/**
 * Parse direct messages and return an array of DirectMessage objects.
 *
 * @param {any[]} messages - Array of messages to parse
 * @param {any} users - Object containing user information
 * @returns {DirectMessage[]} Array of DirectMessage objects
 */
function parseDirectMessages(messages: any[], users: any): DirectMessage[] {
  try {
    return messages.map((msg: any) => ({
      id: msg.message_data.id,
      text: msg.message_data.text,
      senderId: msg.message_data.sender_id,
      recipientId: msg.message_data.recipient_id,
      createdAt: msg.message_data.time,
      mediaUrls: extractMediaUrls(msg.message_data),
      senderScreenName: users[msg.message_data.sender_id]?.screen_name,
      recipientScreenName: users[msg.message_data.recipient_id]?.screen_name,
    }));
  } catch (error) {
    console.error('Error parsing DMs:', error);
    return [];
  }
}

/**
 * Extracts media URLs from message data.
 * @param {any} messageData - The message data containing entities with URLs and media.
 * @returns {string[] | undefined} - An array of media URLs if found, otherwise undefined.
 */
function extractMediaUrls(messageData: any): string[] | undefined {
  const urls: string[] = [];

  // Extract URLs from entities if they exist
  if (messageData.entities?.urls) {
    messageData.entities.urls.forEach((url: any) => {
      urls.push(url.expanded_url);
    });
  }

  // Extract media URLs if they exist
  if (messageData.entities?.media) {
    messageData.entities.media.forEach((media: any) => {
      urls.push(media.media_url_https || media.media_url);
    });
  }

  return urls.length > 0 ? urls : undefined;
}

/**
 * Retrieves a list of direct message conversations for a specific user.
 *
 * @param {string} userId - The ID of the user for whom to fetch direct message conversations.
 * @param {TwitterAuth} auth - The TwitterAuth object containing authentication information.
 * @param {string} [cursor] - Optional parameter for fetching paginated results.
 * @returns {Promise<DirectMessagesResponse>} A Promise that resolves to the response containing direct message conversations.
 * @throws {Error} If authentication is not available to fetch direct messages or if the response is not successful.
 */
export async function getDirectMessageConversations(
  userId: string,
  auth: TwitterAuth,
  cursor?: string
): Promise<DirectMessagesResponse> {
  if (!auth.isLoggedIn()) {
    throw new Error('Authentication required to fetch direct messages');
  }

  const url = 'https://twitter.com/i/api/graphql/7s3kOODhC5vgXlO0OlqYdA/DMInboxTimeline';
  const messageListUrl = 'https://x.com/i/api/1.1/dm/inbox_initial_state.json';

  const params = new URLSearchParams();

  if (cursor) {
    params.append('cursor', cursor);
  }

  const finalUrl = `${messageListUrl}${params.toString() ? `?${params.toString()}` : ''}`;
  const cookies = await auth.cookieJar().getCookies(url);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(url),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const response = await fetch(finalUrl, {
    method: 'GET',
    headers,
  });

  await updateCookieJar(auth.cookieJar(), response.headers);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  // parse the response
  const data = await response.json();
  return parseDirectMessageConversations(data, userId);
}

/**
 * Sends a direct message on Twitter.
 *
 * @param {TwitterAuth} auth - The Twitter authentication object.
 * @param {string} conversation_id - The ID of the conversation to send the message to.
 * @param {string} text - The text of the message to send.
 * @returns {Promise<SendDirectMessageResponse>} A Promise that resolves with the response of sending the direct message.
 * @throws {Error} If authentication is required to send direct messages and the user is not logged in.
 */
export async function sendDirectMessage(
  auth: TwitterAuth,
  conversation_id: string,
  text: string
): Promise<SendDirectMessageResponse> {
  if (!auth.isLoggedIn()) {
    throw new Error('Authentication required to send direct messages');
  }

  const url = 'https://twitter.com/i/api/graphql/7s3kOODhC5vgXlO0OlqYdA/DMInboxTimeline';
  const messageDmUrl = 'https://x.com/i/api/1.1/dm/new2.json';

  const cookies = await auth.cookieJar().getCookies(url);
  const xCsrfToken = cookies.find((cookie) => cookie.key === 'ct0');

  const headers = new Headers({
    authorization: `Bearer ${(auth as any).bearerToken}`,
    cookie: await auth.cookieJar().getCookieString(url),
    'content-type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; Nokia G20) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.88 Mobile Safari/537.36',
    'x-guest-token': (auth as any).guestToken,
    'x-twitter-auth-type': 'OAuth2Client',
    'x-twitter-active-user': 'yes',
    'x-csrf-token': xCsrfToken?.value as string,
  });

  const payload = {
    conversation_id: `${conversation_id}`,
    recipient_ids: false,
    text: text,
    cards_platform: 'Web-12',
    include_cards: 1,
    include_quote_count: true,
    dm_users: false,
  };

  const response = await fetch(messageDmUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  await updateCookieJar(auth.cookieJar(), response.headers);

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return await response.json();
}
