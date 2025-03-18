import type { Agent, Character, UUID, Memory } from '@elizaos/core';
import { WorldManager } from './world-manager';

const API_PREFIX = '/api';
const BASE_URL = `http://localhost:${import.meta.env.VITE_SERVER_PORT}${API_PREFIX}`;

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
  const normalizedUrl = url.startsWith('/') ? url : `/${url}`;

  // Construct the full URL
  const fullUrl = `${BASE_URL}${normalizedUrl}`;

  console.log('API Request:', method || 'GET', fullUrl);

  const options: RequestInit = {
    method: method ?? 'GET',
    headers: headers
      ? headers
      : {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
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
    const response = await fetch(fullUrl, options);
    const contentType = response.headers.get('Content-Type');

    if (contentType === 'audio/mpeg') {
      return await response.blob();
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error:', response.status, response.statusText);
      console.error('Response:', errorText);

      let errorMessage = `Error ${response.status}: ${response.statusText}`;
      try {
        const errorObj = JSON.parse(errorText);
        errorMessage = errorObj.message || errorMessage;
      } catch {
        // If we can't parse as JSON, use the raw text
        if (errorText.includes('<!DOCTYPE html>')) {
          errorMessage = 'Received HTML instead of JSON. API endpoint may be incorrect.';
        } else {
          errorMessage = errorText || errorMessage;
        }
      }

      throw new Error(errorMessage);
    }

    // For successful responses, try to parse as JSON
    if (contentType?.includes('application/json')) {
      try {
        return await response.json();
      } catch (error) {
        console.error('JSON Parse Error:', error);
        const text = await response.text();
        console.error('Response text:', text.substring(0, 500) + (text.length > 500 ? '...' : ''));
        throw new Error('Failed to parse JSON response');
      }
    } else {
      // For non-JSON responses, return text
      return await response.text();
    }
  } catch (error) {
    console.error('Fetch error:', error);
    throw error;
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
 * 		getAgentMemories: (agentId: UUID, roomId?: UUID) => Promise<any>;
 * 		deleteAgentMemory: (agentId: UUID, memoryId: string) => Promise<any>;
 * 		updateAgentMemory: (agentId: UUID, memoryId: string, memoryData: Partial<Memory>) => Promise<any>;
 * 	}
 * }}
 */
export const apiClient = {
  getAgents: () => fetcher({ url: '/agents' }),
  getAgent: (agentId: string): Promise<{ data: Agent }> => fetcher({ url: `/agents/${agentId}` }),
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
  updateAgent: (agentId: string, agent: Agent) =>
    fetcher({
      url: `/agents/${agentId}`,
      method: 'PATCH',
      body: agent,
    }),
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

  // Room-related routes
  getRooms: () => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/world/${worldId}/rooms`,
      method: 'GET',
    });
  },

  getRoomsForParticipant: (agentId: string) => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/agents/${agentId}/rooms`,
      method: 'GET',
      body: { worldId },
    });
  },

  createRoom: (
    agentId: string,
    roomName: string,
    serverId: string,
    source: string,
    metadata?: any
  ) => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/agents/${agentId}/rooms`,
      method: 'POST',
      body: {
        name: roomName,
        worldId,
        source,
        metadata,
        serverId,
      },
    });
  },

  // Room management functions
  getRoom: (agentId: string, roomId: string) => {
    return fetcher({
      url: `/agents/${agentId}/rooms/${roomId}`,
      method: 'GET',
    });
  },

  updateRoom: (agentId: string, roomId: string, updates: { name?: string; worldId?: string }) => {
    return fetcher({
      url: `/agents/${agentId}/rooms/${roomId}`,
      method: 'PATCH',
      body: updates,
    });
  },

  deleteRoom: (agentId: string, roomId: string) => {
    return fetcher({
      url: `/agents/${agentId}/rooms/${roomId}`,
      method: 'DELETE',
    });
  },

  // Add this new method
  getLogs: ({ level = '', agentName = 'all', agentId = 'all' }): Promise<LogResponse> => {
    const params = new URLSearchParams();

    if (level && level !== 'all') params.append('level', level);
    if (agentName && agentName !== 'all') params.append('agentName', agentName);
    if (agentId && agentId !== 'all') params.append('agentId', agentId);

    const url = `/logs${params.toString() ? `?${params.toString()}` : ''}`;
    return fetcher({
      url,
      method: 'GET',
    });
  },

  getAgentCompletion: (
    agentId: string,
    senderId: string,
    message: string,
    roomId: UUID,
    source: string
  ) => {
    return fetcher({
      url: `/agents/${agentId}/message`,
      method: 'POST',
      body: {
        text: message,
        roomId: roomId,
        senderId,
        source,
      },
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
  getAgentMemories: (agentId: UUID, roomId?: UUID) => {
    const url = roomId
      ? `/agents/${agentId}/rooms/${roomId}/memories`
      : `/agents/${agentId}/memories`;

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

  getGroupMemories: (serverId: UUID) => {
    const worldId = WorldManager.getWorldId();
    return fetcher({
      url: `/world/${worldId}/memories/${serverId}`,
      method: 'GET',
    });
  },
};
