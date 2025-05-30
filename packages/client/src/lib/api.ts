import type { Agent, Character, UUID, Memory as CoreMemory, Room as CoreRoom } from '@elizaos/core';
import clientLogger from './logger';
import { connectionStatusActions } from '../context/ConnectionContext';
import {
  ServerMessage,
  MessageServer,
  MessageChannel,
  AgentWithStatus,
  AgentPanel,
} from '../types';

// Interface for Memory from @elizaos/core, potentially extended for client needs
interface ClientMemory extends CoreMemory {
  // any client-specific extensions to Memory if needed
}

/**
 * Represents a log entry with specific properties.
 * @typedef {Object} LogEntry
 * @property {number} level - The level of the log entry.
 * @property {number} time - The time the log entry was created.
 * @property {string} msg - The message of the log entry.
 * @property {string | number | boolean | null | undefined} [key] - Additional key-value pairs for the log entry.
 */
interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: string | number | boolean | null | undefined;
}

interface LogResponse {
  logs: LogEntry[];
  count: number;
  total: number;
  level: string;
  levels: string[];
}

type AgentLog = {
  id?: string;
  type?: string;
  timestamp?: number;
  message?: string;
  details?: string;
  roomId?: string;
  body?: {
    modelType?: string;
    modelKey?: string;
    params?: any;
    response?: any;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  createdAt?: number;
  [key: string]: any;
};

const API_PREFIX = '/api';
const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

const fetcher = async ({
  url,
  method,
  body,
  headers,
}: {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  body?: object | FormData;
  headers?: HeadersInit;
}) => {
  const normalizedUrl = API_PREFIX + (url.startsWith('/') ? url : `/${url}`);
  clientLogger.info('API Request:', method || 'GET', normalizedUrl);
  const storageKey = getLocalStorageApiKey();
  const apiKey = localStorage.getItem(storageKey);
  const baseHeaders: HeadersInit = headers
    ? { ...headers }
    : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
  if (apiKey) {
    (baseHeaders as Record<string, string>)['X-API-KEY'] = apiKey;
  }
  const options: RequestInit = {
    method: method ?? 'GET',
    headers: baseHeaders,
    signal: method === 'DELETE' || method === 'POST' ? AbortSignal.timeout(30000) : undefined,
  };
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    if (body instanceof FormData) {
      // Let browser set Content-Type for FormData
      if (options.headers && typeof options.headers === 'object') {
        delete (options.headers as Record<string, string>)['Content-Type'];
      }
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
    }
  }
  try {
    const response = await fetch(normalizedUrl, options);
    const contentType = response.headers.get('Content-Type');

    if (response.status === 204) {
      // No Content
      return { success: true, data: null }; // Or just return undefined/null based on expected behavior
    }

    if (contentType?.startsWith('audio/')) {
      return await response.blob();
    }
    if (!response.ok) {
      const errorText = await response.text();
      clientLogger.error('API Error:', response.status, response.statusText, {
        url: normalizedUrl,
        options,
      });
      clientLogger.error('Response:', errorText);
      let errorMessage = `${response.status}: ${response.statusText}`;
      let errorObj: any = {};
      try {
        errorObj = JSON.parse(errorText);
        errorMessage = errorObj.error?.message || errorObj.message || errorMessage;
        if (!errorMessage.includes(response.status.toString())) {
          errorMessage = `${response.status}: ${errorMessage}`;
        }
      } catch {
        if (errorText.includes('<!DOCTYPE html>')) {
          errorMessage = `${response.status}: Received HTML instead of JSON. API endpoint may be incorrect.`;
        } else {
          errorMessage = errorText ? `${response.status}: ${errorText}` : errorMessage;
        }
      }
      if (response.status === 401) {
        const unauthorizedMessage =
          errorObj?.error?.message ||
          errorObj?.message ||
          `Unauthorized: Invalid or missing X-API-KEY. Server responded with ${response.status}.`;
        connectionStatusActions.setUnauthorized(unauthorizedMessage);
        errorMessage = unauthorizedMessage;
      } else if (response.status === 404) {
        errorMessage = `${errorMessage} - API endpoint not found`;
      } else if (response.status === 403) {
        errorMessage = `${errorMessage} - Access denied`;
      } else if (response.status === 429) {
        errorMessage = `${errorMessage} - Too many requests, please try again later`;
      } else if (response.status >= 500) {
        errorMessage = `${errorMessage} - Server error, please check server logs`;
      }
      const error = new Error(errorMessage);
      (error as any).statusCode = response.status;
      (error as any).responseBody = errorObj; // Attach parsed error body if available
      throw error;
    }
    if (contentType?.includes('application/json')) {
      try {
        const jsonData = await response.json();
        return jsonData;
      } catch (error) {
        const text = await response.text();
        clientLogger.error('JSON Parse Error:', error);
        clientLogger.error(
          'Response text:',
          text.substring(0, 500) + (text.length > 500 ? '...' : '')
        );
        throw new Error('Failed to parse JSON response');
      }
    } else {
      // For non-JSON, non-audio responses, return text (e.g. plain text, HTML if error wasn't caught)
      return await response.text();
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      clientLogger.error('Network Error:', error);
      connectionStatusActions.setOfflineStatus(true); // Inform UI about network issue
      throw new Error(
        'NetworkError: Unable to connect to the server. Please check if the server is running and your internet connection.'
      );
    } else if (error instanceof Error && error.name === 'AbortError') {
      clientLogger.error('Request Timeout:', error);
      throw new Error('RequestTimeout: The request took too long to complete.');
    } else if (error instanceof DOMException && error.name === 'NetworkError') {
      clientLogger.error('Cross-Origin Error or Network Issue:', error);
      connectionStatusActions.setOfflineStatus(true);
      throw new Error(
        'NetworkError: A network issue occurred. This could be a CORS problem or a general network failure.'
      );
    } else {
      clientLogger.error('Fetch error:', error);
      throw error;
    }
  }
};

export const apiClient = {
  // Agent specific
  getAgents: (): Promise<{ data: { agents: Partial<AgentWithStatus>[] } }> =>
    fetcher({ url: '/agents' }),
  getAgent: (agentId: string): Promise<{ data: AgentWithStatus }> =>
    fetcher({ url: `/agents/${agentId}` }),
  deleteAgent: (agentId: string): Promise<{ success: boolean }> =>
    fetcher({ url: `/agents/${agentId}`, method: 'DELETE' }),
  updateAgent: (agentId: string, agentData: Partial<Agent>) =>
    fetcher({ url: `/agents/${agentId}`, method: 'PATCH', body: agentData }),
  createAgent: (params: { characterPath?: string; characterJson?: Character }) =>
    fetcher({ url: '/agents/', method: 'POST', body: params }),
  startAgent: (agentId: UUID): Promise<{ data: { id: UUID; name: string; status: string } }> =>
    fetcher({ url: `/agents/${agentId}`, method: 'POST', body: { start: true } }),
  stopAgent: (agentId: string): Promise<{ data: { message: string } }> =>
    fetcher({ url: `/agents/${agentId}`, method: 'PUT' }),
  getAgentPanels: (agentId: string): Promise<{ success: boolean; data: AgentPanel[] }> =>
    fetcher({ url: `/agents/${agentId}/panels`, method: 'GET' }),

  // Agent-perspective rooms and memories
  getAgentPerspectiveRooms: (agentId: string): Promise<{ data: { rooms: CoreRoom[] } }> =>
    fetcher({ url: `/agents/${agentId}/rooms` }),
  getRawAgentMemoriesForRoom: (
    agentId: UUID,
    agentPerspectiveRoomId: UUID,
    tableName = 'messages',
    options?: { limit?: number; before?: number; includeEmbedding?: boolean }
  ): Promise<{ data: { memories: CoreMemory[] } }> => {
    const queryParams = new URLSearchParams({ tableName });
    if (options?.limit) queryParams.append('limit', String(options.limit));
    if (options?.before) queryParams.append('before', String(options.before));
    if (options?.includeEmbedding) queryParams.append('includeEmbedding', 'true');
    return fetcher({
      url: `/agents/${agentId}/rooms/${agentPerspectiveRoomId}/memories?${queryParams.toString()}`,
    });
  },
  deleteAgentPerspectiveMemory: (agentId: UUID, memoryId: string) =>
    fetcher({ url: `/agents/${agentId}/memories/${memoryId}`, method: 'DELETE' }),
  deleteAllAgentPerspectiveMemories: (agentId: UUID, agentPerspectiveRoomId: UUID) =>
    fetcher({ url: `/agents/${agentId}/memories/all/${agentPerspectiveRoomId}`, method: 'DELETE' }),
  updateAgentPerspectiveMemory: (
    agentId: UUID,
    memoryId: string,
    memoryData: Partial<CoreMemory>
  ) =>
    fetcher({ url: `/agents/${agentId}/memories/${memoryId}`, method: 'PATCH', body: memoryData }),

  // Central Message System Endpoints
  getCentralServers: (): Promise<{ data: { servers: MessageServer[] } }> =>
    fetcher({ url: '/messages/central-servers' }),
  createCentralServer: (payload: {
    name: string;
    sourceType: string;
    sourceId?: string;
    metadata?: any;
  }): Promise<{ data: { server: MessageServer } }> =>
    fetcher({ url: '/messages/servers', method: 'POST', body: payload }),
  getCentralChannelsForServer: (
    serverId: UUID
  ): Promise<{ data: { channels: MessageChannel[] } }> =>
    fetcher({ url: `/messages/central-servers/${serverId}/channels` }),
  getCentralChannelMessages: (
    channelId: UUID,
    options?: {
      limit?: number;
      before?: number;
    }
  ): Promise<{ data: { messages: ServerMessage[] } }> => {
    const queryParams = new URLSearchParams();
    if (options?.limit) queryParams.append('limit', String(options.limit));
    if (options?.before) queryParams.append('before', String(options.before));
    return fetcher({
      url: `/messages/central-channels/${channelId}/messages?${queryParams.toString()}`,
    });
  },
  postMessageToCentralChannel: (
    channelId: UUID,
    payload: {
      author_id: UUID;
      content: string;
      server_id: UUID;
      in_reply_to_message_id?: UUID;
      raw_message?: any;
      metadata?: any;
      source_type?: string;
    }
  ): Promise<{ success: boolean; data: ServerMessage }> =>
    fetcher({
      url: `/messages/central-channels/${channelId}/messages`,
      method: 'POST',
      body: payload,
    }),
  getOrCreateDmChannel: (
    targetCentralUserId: UUID,
    currentUserId: UUID
  ): Promise<{ success: boolean; data: MessageChannel }> =>
    fetcher({
      url: `/messages/dm-channel?targetUserId=${targetCentralUserId}&currentUserId=${currentUserId}`,
    }),
  createCentralGroupChat: (payload: {
    name: string;
    participantCentralUserIds: UUID[];
    type?: string;
    server_id?: UUID;
    metadata?: any;
  }): Promise<{ data: MessageChannel }> =>
    fetcher({ url: '/messages/central-channels', method: 'POST', body: payload }),

  // Ping, TTS, Transcription, Media Upload, Knowledge (agent-specific or global services)
  ping: (): Promise<{ pong: boolean; timestamp: number }> => fetcher({ url: '/ping' }),
  ttsStream: (agentId: string, text: string): Promise<Blob> =>
    fetcher({
      url: `/agents/${agentId}/speech/generate`,
      method: 'POST',
      body: { text },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/*',
      },
    }),
  transcribeAudio: async (
    agentId: string,
    audioBlob: Blob
  ): Promise<{ success: boolean; data: { text: string } }> => {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.wav');
    return fetcher({ url: `/agents/${agentId}/transcriptions`, method: 'POST', body: formData });
  },
  uploadAgentMedia: async (
    agentId: string,
    file: File
  ): Promise<{ success: boolean; data: { url: string; type: string } }> => {
    const formData = new FormData();
    formData.append('file', file);
    return fetcher({ url: `/agents/${agentId}/upload-media`, method: 'POST', body: formData });
  },
  uploadKnowledgeDocuments: async (agentId: string, files: File[]): Promise<any> => {
    const formData = new FormData();
    for (const file of files) formData.append('files', file);
    return fetcher({
      url: `/agents/${agentId}/plugins/knowledge/upload`,
      method: 'POST',
      body: formData,
    });
  },
  getKnowledgeDocuments: (
    agentId: string,
    _options?: { limit?: number; before?: number; includeEmbedding?: boolean }
  ): Promise<any> => fetcher({ url: `/agents/${agentId}/plugins/knowledge/documents` }),
  deleteKnowledgeDocument: (agentId: string, knowledgeId: string): Promise<void> =>
    fetcher({
      url: `/agents/${agentId}/plugins/knowledge/documents/${knowledgeId}`,
      method: 'DELETE',
    }),

  // Logs
  getGlobalLogs: (
    params: { level?: string; agentName?: string; agentId?: string } = {}
  ): Promise<LogResponse> => {
    const queryParams = new URLSearchParams();
    if (params.level) queryParams.append('level', params.level);
    if (params.agentName) queryParams.append('agentName', params.agentName);
    if (params.agentId) queryParams.append('agentId', params.agentId);
    return fetcher({ url: `/logs${queryParams.toString() ? `?${queryParams.toString()}` : ''}` });
  },
  deleteGlobalLogs: (): Promise<{ status: string; message: string }> =>
    fetcher({ url: '/logs', method: 'DELETE' }),
  getAgentLogs: (
    agentId: string,
    options?: {
      roomId?: UUID;
      type?: string;
      count?: number;
      offset?: number;
    }
  ): Promise<{ success: boolean; data: AgentLog[] }> => {
    const queryParams = new URLSearchParams();
    if (options?.roomId) queryParams.append('roomId', options.roomId);
    if (options?.type) queryParams.append('type', options.type);
    if (options?.count) queryParams.append('count', String(options.count));
    if (options?.offset) queryParams.append('offset', String(options.offset));
    return fetcher({
      url: `/agents/${agentId}/logs${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
    });
  },
  deleteAgentLog: (agentId: string, logId: string): Promise<void> =>
    fetcher({ url: `/agents/${agentId}/logs/${logId}`, method: 'DELETE' }),

  // ENV vars
  getLocalEnvs: (): Promise<{ success: boolean; data: Record<string, string> }> =>
    fetcher({ url: `/envs/local` }),
  updateLocalEnvs: (envs: Record<string, string>): Promise<{ success: boolean; message: string }> =>
    fetcher({ url: `/envs/local`, method: 'POST', body: { content: envs } }),

  testEndpoint: (endpoint: string): Promise<any> => fetcher({ url: endpoint }),

  // PLACEHOLDER - Implement actual backend and uncomment
  deleteCentralChannelMessage: async (channelId: UUID, messageId: UUID): Promise<void> => {
    await fetcher({
      url: `/messages/central-channels/${channelId}/messages/${messageId}`,
      method: 'DELETE',
    });
  },

  // PLACEHOLDER - Implement actual backend and uncomment
  clearCentralChannelMessages: async (channelId: UUID): Promise<void> => {
    await fetcher({
      url: `/messages/central-channels/${channelId}/messages`,
      method: 'DELETE',
    });
  },

  createCentralGroupChannel: (payload: {
    /* ... */
  }): Promise<{ success: boolean; data: MessageChannel }> =>
    fetcher({ url: '/messages/central-channels', method: 'POST', body: payload }),

  getCentralChannelDetails: (
    channelId: UUID
  ): Promise<{ success: boolean; data: MessageChannel | null }> =>
    fetcher({ url: `/messages/central-channels/${channelId}/details` }),

  getCentralChannelParticipants: (channelId: UUID): Promise<{ success: boolean; data: UUID[] }> => {
    return fetcher({ url: `/messages/central-channels/${channelId}/participants` });
  },
};
