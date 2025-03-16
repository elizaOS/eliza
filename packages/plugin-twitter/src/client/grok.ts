import { requestApi } from './api';
import type { TwitterAuth } from './auth';

/**
 * Interface representing a Grok conversation object.
 * @interface
 * @property {Object} data - The data object containing information about the conversation.
 * @property {Object} data.create_grok_conversation - The object containing the created Grok conversation.
 * @property {string} data.create_grok_conversation.conversation_id - The ID of the created conversation.
 */
export interface GrokConversation {
  data: {
    create_grok_conversation: {
      conversation_id: string;
    };
  };
}

/**
 * Interface representing a Grok request.
 *
 * @property {GrokResponseMessage[]} responses - Array of GrokResponseMessage objects.
 * @property {string} systemPromptName - Name of the system prompt.
 * @property {string} grokModelOptionId - ID of the Grok model option.
 * @property {string} conversationId - ID of the conversation.
 * @property {boolean} returnSearchResults - Indicates if search results should be returned.
 * @property {boolean} returnCitations - Indicates if citations should be returned.
 * @property {Object} promptMetadata - Additional metadata for the prompt.
 * @property {string} promptMetadata.promptSource - Source of the prompt.
 * @property {string} promptMetadata.action - Action related to the prompt.
 * @property {number} imageGenerationCount - Number of image generations.
 * @property {Object} requestFeatures - Additional features requested for the request.
 * @property {boolean} requestFeatures.eagerTweets - Indicates if eager tweets are requested.
 * @property {boolean} requestFeatures.serverHistory - Indicates if server history is requested.
 */

export interface GrokRequest {
  responses: GrokResponseMessage[];
  systemPromptName: string;
  grokModelOptionId: string;
  conversationId: string;
  returnSearchResults: boolean;
  returnCitations: boolean;
  promptMetadata: {
    promptSource: string;
    action: string;
  };
  imageGenerationCount: number;
  requestFeatures: {
    eagerTweets: boolean;
    serverHistory: boolean;
  };
}

// Types for the user-facing API
/**
 * Interface representing a GrokMessage object.
 * @interface
 * @property {string} role - The role of the message, can be either "user" or "assistant".
 * @property {string} content - The content of the message.
 */
export interface GrokMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Interface for specifying options when using GrokChat.
 * @typedef {Object} GrokChatOptions
 * @property {GrokMessage[]} messages - Array of GrokMessage objects
 * @property {string} [conversationId] - Optional ID for the conversation. Will create new if not provided
 * @property {boolean} [returnSearchResults] - Flag to indicate whether to return search results
 * @property {boolean} [returnCitations] - Flag to indicate whether to return citations
 */
export interface GrokChatOptions {
  messages: GrokMessage[];
  conversationId?: string; // Optional - will create new if not provided
  returnSearchResults?: boolean;
  returnCitations?: boolean;
}

// Internal types for API requests
/**
 * Interface for a Grok response message.
 * @property {string} message - The message content.
 * @property {1|2} sender - The sender of the message. 1 = user, 2 = assistant.
 * @property {string} [promptSource] - The source of the prompt (optional).
 * @property {any[]} [fileAttachments] - An array of file attachments (optional).
 */
export interface GrokResponseMessage {
  message: string;
  sender: 1 | 2; // 1 = user, 2 = assistant
  promptSource?: string;
  fileAttachments?: any[];
}

// Rate limit information
/**
 * Interface representing a Grok rate limit response.
 * @typedef { Object } GrokRateLimit
 * @property { boolean } isRateLimited - Flag indicating if the rate limit is in effect.
 * @property { string } message - The message associated with the rate limit.
 * @property { Object } upsellInfo - Object containing additional information about the rate limit (optional).
 * @property { string } upsellInfo.usageLimit - The usage limit imposed by the rate limit.
 * @property { string } upsellInfo.quotaDuration - The duration of the quota for the rate limit.
 * @property { string } upsellInfo.title - The title related to the rate limit.
 * @property { string } upsellInfo.message - Additional message related to the rate limit.
 */
export interface GrokRateLimit {
  isRateLimited: boolean;
  message: string;
  upsellInfo?: {
    usageLimit: string;
    quotaDuration: string;
    title: string;
    message: string;
  };
}

/**
 * Interface for the response from the GrokChat API.
 * @typedef {object} GrokChatResponse
 * @property {string} conversationId - The ID of the conversation.
 * @property {string} message - The message content.
 * @property {Array<GrokMessage>} messages - An array of GrokMessage objects.
 * @property {Array<any>} [webResults] - Optional array of web results.
 * @property {object} [metadata] - Optional metadata object.
 * @property {object} [rateLimit] - Optional rate limit information.
 */
export interface GrokChatResponse {
  conversationId: string;
  message: string;
  messages: GrokMessage[];
  webResults?: any[];
  metadata?: any;
  rateLimit?: GrokRateLimit;
}

/**
 * Creates a new conversation with Grok.
 * @returns The ID of the newly created conversation
 * @internal
 */
/**
 * Creates a Grok conversation using the provided Twitter authorization credentials.
 *
 * @param {TwitterAuth} auth - Twitter authorization credentials required to make the API request.
 * @returns {Promise<string>} A promise that resolves with the conversation ID of the newly created Grok conversation.
 */
export async function createGrokConversation(auth: TwitterAuth): Promise<string> {
  const res = await requestApi<GrokConversation>(
    'https://x.com/i/api/graphql/6cmfJY3d7EPWuCSXWrkOFg/CreateGrokConversation',
    auth,
    'POST'
  );

  if (!res.success) {
    throw (res as any).err;
  }

  return res.value.data.create_grok_conversation.conversation_id;
}

/**
 * Main method for interacting with Grok in a chat-like manner.
 */
export async function grokChat(
  options: GrokChatOptions,
  auth: TwitterAuth
): Promise<GrokChatResponse> {
  let { conversationId, messages } = options;

  // Create new conversation if none provided
  if (!conversationId) {
    conversationId = await createGrokConversation(auth);
  }

  // Convert OpenAI-style messages to Grok's internal format
  const responses: GrokResponseMessage[] = messages.map((msg: GrokMessage) => ({
    message: msg.content,
    sender: msg.role === 'user' ? 1 : 2,
    ...(msg.role === 'user' && {
      promptSource: '',
      fileAttachments: [],
    }),
  }));

  const payload: GrokRequest = {
    responses,
    systemPromptName: '',
    grokModelOptionId: 'grok-2a',
    conversationId,
    returnSearchResults: options.returnSearchResults ?? true,
    returnCitations: options.returnCitations ?? true,
    promptMetadata: {
      promptSource: 'NATURAL',
      action: 'INPUT',
    },
    imageGenerationCount: 4,
    requestFeatures: {
      eagerTweets: true,
      serverHistory: true,
    },
  };

  const res = await requestApi<{ text: string }>(
    'https://api.x.com/2/grok/add_response.json',
    auth,
    'POST',
    undefined,
    payload
  );

  if (!res.success) {
    throw (res as any).err;
  }

  // Parse response chunks - Grok may return either a single response or multiple chunks
  let chunks: any[];
  if (res.value.text) {
    // For streaming responses, split text into chunks and parse each JSON chunk
    chunks = res.value.text
      .split('\n')
      .filter(Boolean)
      .map((chunk: any) => JSON.parse(chunk));
  } else {
    // For single responses (like rate limiting), wrap in array
    chunks = [res.value];
  }

  // Check if we hit rate limits by examining first chunk
  const firstChunk = chunks[0];
  if (firstChunk.result?.responseType === 'limiter') {
    return {
      conversationId,
      message: firstChunk.result.message,
      messages: [...messages, { role: 'assistant', content: firstChunk.result.message }],
      rateLimit: {
        isRateLimited: true,
        message: firstChunk.result.message,
        upsellInfo: firstChunk.result.upsell
          ? {
              usageLimit: firstChunk.result.upsell.usageLimit,
              quotaDuration: `${firstChunk.result.upsell.quotaDurationCount} ${firstChunk.result.upsell.quotaDurationPeriod}`,
              title: firstChunk.result.upsell.title,
              message: firstChunk.result.upsell.message,
            }
          : undefined,
      },
    };
  }

  // Combine all message chunks into single response
  const fullMessage = chunks
    .filter((chunk: any) => chunk.result?.message)
    .map((chunk: any) => chunk.result.message)
    .join('');

  // Return complete response with conversation history and metadata
  return {
    conversationId,
    message: fullMessage,
    messages: [...messages, { role: 'assistant', content: fullMessage }],
    webResults: chunks.find((chunk: any) => chunk.result?.webResults)?.result.webResults,
    metadata: chunks[0],
  };
}
