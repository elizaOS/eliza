import type { Agent, Character, UUID, Memory } from '@elizaos/core';
import { WorldManager } from './world-manager';
import clientLogger from './logger';

const API_PREFIX = '/api';

// Key for storing the API key in localStorage, now a function
const getLocalStorageApiKey = () => `eliza-api-key-${window.location.origin}`;

/**
 * A function that handles fetching data from a specified URL with various options.
 *
 * @param url - The URL to fetch data from.
 * @param method - The HTTP method to use for the request. Defaults to "GET" if not provided.
 * @param body - The data to be sent in the request body. Can be either an object or FormData.
 * @param headers - The headers to include in the request.
 * @returns A Promise that resolves to the response data based on the Content-Type of the response.
 */
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
  // Ensure URL starts with a slash if it's a relative path
  const normalizedUrl = API_PREFIX + (url.startsWith('/') ? url : `/${url}`);

  clientLogger.info('API Request:', method || 'GET', normalizedUrl);

  // --- BEGIN Add API Key Header ---
  const storageKey = getLocalStorageApiKey();
  const apiKey = localStorage.getItem(storageKey);
  const baseHeaders = headers
    ? { ...headers } // Clone if headers are provided
    : {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };

  if (apiKey) {
    (baseHeaders as Record<string, string>)['X-API-KEY'] = apiKey;
  }
  // --- END Add API Key Header ---

  const options: RequestInit = {
    method: method ?? 'GET',
    headers: baseHeaders, // Use the modified headers
    // Add timeout signal for DELETE operations to prevent hanging
    signal: method === 'DELETE' ? AbortSignal.timeout(30000) : undefined,
  };

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    if (body instanceof FormData) {
      if (options.headers && typeof options.headers === 'object') {
        // Create new headers object without Content-Type
        options.headers = Object.fromEntries(
          Object.entries(options.headers as Record<string, string>).filter(
            ([key]) => key !== 'Content-Type'
          )
        );
      }
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(normalizedUrl, options);
    const contentType = response.headers.get('Content-Type');

    if (contentType === 'audio/mpeg') {
      return await response.blob();
    }

    if (!response.ok) {
      const errorText = await response.text();

      clientLogger.error('API Error:', response.status, response.statusText);
      clientLogger.error('Response:', errorText);

      let errorMessage = `${response.status}: ${response.statusText}`;
      try {
        const errorObj = JSON.parse(errorText);
        errorMessage = errorObj.error?.message || errorObj.message || errorMessage;

        // Include the status code explicitly in the error message
        if (!errorMessage.includes(response.status.toString())) {
          errorMessage = `${response.status}: ${errorMessage}`;
        }
      } catch {
        // If we can't parse as JSON, use the raw text
        if (errorText.includes('<!DOCTYPE html>')) {
          errorMessage = `${response.status}: Received HTML instead of JSON. API endpoint may be incorrect.`;
        } else {
          errorMessage = errorText ? `${response.status}: ${errorText}` : errorMessage;
        }
      }

      // Add more context to specific HTTP status codes
      if (response.status === 404) {
        errorMessage = `${errorMessage} - API endpoint not found`;
      } else if (response.status === 403) {
        errorMessage = `${errorMessage} - Access denied`;
      } else if (response.status === 401) {
        errorMessage = `${errorMessage} - Authentication required`;
      } else if (response.status === 429) {
        errorMessage = `${errorMessage} - Too many requests, please try again later`;
      } else if (response.status >= 500) {
        errorMessage = `${errorMessage} - Server error, please check server logs`;
      }

      const error = new Error(errorMessage);
      // Add status code to the error object for easier checking
      (error as any).statusCode = response.status;
      throw error;
    }

    // For successful responses, try to parse as JSON
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
      // For non-JSON responses, return text
      const textResponse = await response.text();
      return textResponse;
    }
  } catch (error) {
    // Enhanced error handling with more specific messages
    if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
      clientLogger.error('Network Error:', error);
      throw new Error(
        'NetworkError: Unable to connect to the server. Please check if the server is running.'
      );
    } else if (error instanceof Error && error.name === 'AbortError') {
      clientLogger.error('Request Timeout:', error);
      throw new Error('RequestTimeout: The request took too long to complete.');
    } else if (error instanceof DOMException && error.name === 'NetworkError') {
      clientLogger.error('Cross-Origin Error:', error);
      throw new Error(
        'NetworkError: Cross-origin request failed. Please check server CORS settings.'
      );
    } else {
      clientLogger.error('Fetch error:', error);
      throw error;
    }
  }
};

// Add these interfaces near the top with other types
/**
 * Interface representing a log entry.
 * @property {number} level - The log level.
 * @property {number} time - The timestamp of the log entry.
 * @property {string} msg - The log message.
 * @property {string | number | boolean | null | undefined} [key] - Additional properties for the log entry.
 */
interface LogEntry {
  level: number;
  time: number;
  msg: string;
  [key: string]: string | number | boolean | null | undefined;
}

/**
 * Interface representing a log response.
 * @typedef {Object} LogResponse
 * @property {LogEntry[]} logs - Array of log entries.
 * @property {number} count - Number of log entries in the response.
 * @property {number} total - Total number of log entries available.
 * @property {string} level - Log level of the response.
 * @property {string[]} levels - Array of available log levels.
 */
interface LogResponse {
  logs: LogEntry[];
  count: number;
  total: number;
  level: string;
  levels: string[];
}

interface AgentLog {
  id?: string;
  type?: string;
  timestamp?: number;
  message?: string;
  details?: string;
  roomId?: string;
  [key: string]: any;
}

/**
 * Library for interacting with the API to perform various actions related to agents, messages, rooms, logs, etc.
 * @type {{
 * 	apiClient: {
 * 		sendMessage: (agentId: string, message: string, selectedFile?: File | null, roomId?: UUID) => Promise<any>;
 * 		getAgents: () => Promise<any>;
 * 		getAgent: (agentId: string) => Promise<{ data: Agent }>;
 * 		tts: (agentId: string, text: string) => Promise<any>;
 * 		whisper: (agentId: string, audioBlob: Blob) => Promise<any>;
 * 		sendAudioMessage: (agentId: string, audioBlob: Blob, options?: { roomId?: string; entityId?: string; userName?: string; name?: string; }) => Promise<any>;
 * 		speechConversation: (agentId: string, text: string, options?: { roomId?: string; entityId?: string; userName?: string; name?: string; }) => Promise<any>;
 * 		deleteAgent: (agentId: string) => Promise<{ success: boolean }>;
 * 		updateAgent: (agentId: string, agent: Agent) => Promise<any>;
 * 		createAgent: (params: { characterPath?: string; characterJson?: Character; }) => Promise<any>;
 * 		startAgent: (agentId: UUID) => Promise<any>;
 * 		stopAgent: (agentId: string) => Promise<any>;
 * 		getMemories: (agentId: string, roomId: string, options?: { limit?: number; before?: number; }) => Promise<any>;
 * 		getRooms: (agentId: string) => Promise<any>;
 * 		createRoom: (agentId: string, roomName: string) => Promise<any>;
 * 		getRoom: (agentId: string, roomId: string) => Promise<any>;
 * 		updateRoom: (agentId: string, roomId: string, updates: { name?: string; worldId?: string; }) => Promise<any>;
 * 		deleteRoom: (agentId: string, roomId: string) => Promise<any>;
 * 		getLogs: (level: string) => Promise<LogResponse>;
 * 		getAgentLogs: (agentId: string, options?: { roomId?: UUID; type?: string; count?: number; offset?: number }) => Promise<{ success: boolean; data: AgentLog[] }>;
 * 		deleteLog: (agentId: string, logId: string) => Promise<void>;
 * 		getAgentMemories: (agentId: UUID, roomId?: UUID, tableName?: string) => Promise<any>;
 * 		deleteAgentMemory: (agentId: UUID, memoryId: string) => Promise<any>;
 * 		updateAgentMemory: (agentId: UUID, memoryId: string, memoryData: Partial<Memory>) => Promise<any>;
 * 	}
 * }}
 */
export const apiClient = {
  getAgents: () => fetcher({ url: '/agents' }),
  getAgent: (agentId: string): Promise<{ data: Agent }> => fetcher({ url: `/agents/${agentId}` }),
  ping: (): Promise<{ pong: boolean; timestamp: number }> => fetcher({ url: '/ping' }),
  testEndpoint: (endpoint: string): Promise<any> => fetcher({ url: endpoint }),
  tts: (agentId: string, text: string) =>
    fetcher({
      url: `/agents/${agentId}/speech/generate`,
      method: 'POST',
      body: {
        text,
      },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      },
    }),
  whisper: async (agentId: string, audioBlob: Blob) => {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.wav');
    return fetcher({
      url: `/agents/${agentId}/transcriptions`,
      method: 'POST',
      body: formData,
    });
  },
  sendAudioMessage: async (
    agentId: string,
    audioBlob: Blob,
    options?: {
      roomId?: string;
      entityId?: string;
      userName?: string;
      name?: string;
    }
  ) => {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.wav');

    // Add optional parameters if provided
    if (options) {
      for (const [key, value] of Object.entries(options)) {
        if (value) formData.append(key, value);
      }
    }

    return fetcher({
      url: `/agents/${agentId}/audio-messages`,
      method: 'POST',
      body: formData,
    });
  },
  speechConversation: async (
    agentId: string,
    text: string,
    options?: {
      roomId?: string;
      entityId?: string;
      userName?: string;
      name?: string;
    }
  ) => {
    return fetcher({
      url: `/agents/${agentId}/speech/conversation`,
      method: 'POST',
      body: {
        text,
        ...options,
      },
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      },
    });
  },
  deleteAgent: (agentId: string): Promise<{ success: boolean }> =>
    fetcher({ url: `/agents/${agentId}`, method: 'DELETE' }),
  updateAgent: async (agentId: string, agent: Agent) => {
    return fetcher({
      url: `/agents/${agentId}`,
      method: 'PATCH',
      body: agent,
    });
  },
  createAgent: (params: { characterPath?: string; characterJson?: Character }) =>
    fetcher({
      url: '/agents/',
      method: 'POST',
      body: params,
    }),
  startAgent: (agentId: UUID) =>
    fetcher({
      url: `/agents/${agentId}`,
      method: 'POST',
      body: { start: true },
    }),
  stopAgent: (agentId: string) => {
    return fetcher({
      url: `/agents/${agentId}`,
      method: 'PUT',
    });
  },

  // Get memories for a specific room
  getMemories: (agentId: string, roomId: string, options?: { limit?: number; before?: number }) => {
    const worldId = WorldManager.getWorldId();
    const params: Record<string, string | number> = { worldId };

    if (options?.limit) {
      params.limit = options.limit;
    }

    if (options?.before) {
      params.end = options.before;
    }

    return fetcher({
      url: `/agents/${agentId}/rooms/${roomId}/memories`,
      method: 'GET',
      body: params,
    });
  },

  // get all rooms in the world
  getRooms: () => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/world/${worldId}/rooms`,
      method: 'GET',
    });
  },

  getLogs: ({
    level,
    agentName,
    agentId,
  }: {
    level?: string;
    agentName?: string;
    agentId?: string;
  }): Promise<LogResponse> => {
    const params = new URLSearchParams();

    if (level) params.append('level', level);
    if (agentName) params.append('agentName', agentName);
    if (agentId) params.append('agentId', agentId);

    const url = `/logs${params.toString() ? `?${params.toString()}` : ''}`;
    return fetcher({
      url,
      method: 'GET',
    });
  },

  // Method to clear logs
  deleteLogs: (): Promise<{ status: string; message: string }> => {
    return fetcher({
      url: '/logs',
      method: 'DELETE',
    });
  },

  // Agent Log/Action endpoints
  getAgentLogs: (
    agentId: string,
    options?: { roomId?: UUID; type?: string; count?: number; offset?: number }
  ): Promise<{ success: boolean; data: AgentLog[] }> => {
    const params = new URLSearchParams();

    if (options?.roomId) params.append('roomId', options.roomId);
    if (options?.type) params.append('type', options.type);
    if (options?.count) params.append('count', options.count.toString());
    if (options?.offset) params.append('offset', options.offset.toString());

    return fetcher({
      url: `/agents/${agentId}/logs${params.toString() ? `?${params.toString()}` : ''}`,
      method: 'GET',
    });
  },

  deleteLog: (agentId: string, logId: string): Promise<void> => {
    return fetcher({
      url: `/agents/${agentId}/logs/${logId}`,
      method: 'DELETE',
    });
  },

  // Method to get all memories for an agent, optionally filtered by room
  getAgentMemories: (agentId: UUID, roomId?: UUID, tableName?: string) => {
    const params = new URLSearchParams();
    if (tableName) params.append('tableName', tableName);

    const url = roomId
      ? `/agents/${agentId}/rooms/${roomId}/memories`
      : `/agents/${agentId}/memories${params.toString() ? `?${params.toString()}` : ''}`;

    return fetcher({
      url,
      method: 'GET',
    });
  },

  // Method to delete a specific memory for an agent
  deleteAgentMemory: (agentId: UUID, memoryId: string) => {
    return fetcher({
      url: `/agents/${agentId}/memories/${memoryId}`,
      method: 'DELETE',
    });
  },

  updateAgentMemory: (agentId: UUID, memoryId: string, memoryData: Partial<Memory>) => {
    return fetcher({
      url: `/agents/${agentId}/memories/${memoryId}`,
      method: 'PATCH',
      body: memoryData,
    });
  },

  // Method to upload knowledge for an agent
  uploadKnowledge: async (agentId: string, files: File[]): Promise<any> => {
    const formData = new FormData();

    for (const file of files) {
      formData.append('files', file);
    }

    return fetcher({
      url: `/agents/${agentId}/memories/upload-knowledge`,
      method: 'POST',
      body: formData,
    });
  },

  getGroupMemories: (serverId: UUID) => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/world/${worldId}/memories/${serverId}`,
      method: 'GET',
    });
  },

  createGroupChat: (
    agentIds: string[],
    roomName: string,
    serverId: string,
    source: string,
    metadata?: any
  ) => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/agents/groups/${serverId}`,
      method: 'POST',
      body: {
        agentIds,
        name: roomName,
        worldId,
        source,
        metadata,
      },
    });
  },

  deleteGroupChat: (serverId: string) => {
    return fetcher({
      url: `/agents/groups/${serverId}`,
      method: 'DELETE',
    });
  },

  getLocalEnvs: () => {
    return fetcher({
      url: `/envs/local`,
      method: 'GET',
    });
  },

  updateLocalEnvs: (envs: Record<string, string>) => {
    return fetcher({
      url: `/envs/local`,
      method: 'POST',
      body: {
        content: envs,
      },
    });
  },

  getGlobalEnvs: () => {
    return fetcher({
      url: `/envs/global`,
      method: 'GET',
    });
  },

  updateGlobalEnvs: (envs: Record<string, string>) => {
    return fetcher({
      url: `/envs/global`,
      method: 'POST',
      body: {
        content: envs,
      },
    });
  },
};
