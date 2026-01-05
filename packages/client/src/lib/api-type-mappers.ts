import {
  Agent as ApiAgent,
  AgentLog as ApiAgentLog,
  Message as ApiMessage,
  MessageChannel as ApiMessageChannel,
  MessageServer as ApiMessageServer,
  Memory as ApiMemory,
} from '@elizaos/api-client';
import { Agent, AgentStatus, UUID, ChannelType, Memory, Media } from '@elizaos/core';
import type {
  MessageChannel as ClientMessageChannel,
  MessageServer as ClientMessageServer,
} from '../types';
import type { UiMessage } from '../hooks/use-query-hooks';

// Convert API Agent to core Agent type
// ApiAgent is now the core Agent type (re-exported from @elizaos/api-client)
export function mapApiAgentToClient(apiAgent: ApiAgent): Agent {
  return {
    ...apiAgent,
    id: apiAgent.id as UUID,
    createdAt: apiAgent.createdAt,
    updatedAt: apiAgent.updatedAt,
  };
}

// Convert Date to string for API
export function dateToApiString(date: Date | string | number): string {
  if (date instanceof Date) {
    return date.toISOString();
  }
  if (typeof date === 'number') {
    return new Date(date).toISOString();
  }
  return date;
}

// Convert API date (Date object or string) to timestamp (ms)
export function apiDateToTimestamp(date: Date | string | number): number {
  if (date instanceof Date) {
    return date.getTime();
  }
  if (typeof date === 'string') {
    return new Date(date).getTime();
  }
  return date;
}

// Convert API date to string
export function apiDateToString(date: Date | string): string {
  if (date instanceof Date) {
    return date.toISOString();
  }
  return date;
}

// Map API MessageChannel to client MessageChannel
export function mapApiChannelToClient(apiChannel: ApiMessageChannel): ClientMessageChannel {
  return {
    ...apiChannel,
    id: apiChannel.id as UUID,
    messageServerId: apiChannel.messageServerId as UUID,
    type: apiChannel.type as ChannelType,
    createdAt: apiDateToString(apiChannel.createdAt),
    updatedAt: apiDateToString(apiChannel.updatedAt),
  };
}

// Map API MessageServer to client MessageServer
export function mapApiServerToClient(apiServer: ApiMessageServer): ClientMessageServer {
  return {
    ...apiServer,
    id: apiServer.id as UUID,
    createdAt: apiDateToString(apiServer.createdAt),
    updatedAt: apiDateToString(apiServer.updatedAt),
  };
}

// Map array of API Servers to client MessageServers
export function mapApiServersToClient(apiServers: ApiMessageServer[]): ClientMessageServer[] {
  return apiServers.map(mapApiServerToClient);
}

// Map array of API Channels to client MessageChannels
export function mapApiChannelsToClient(apiChannels: ApiMessageChannel[]): ClientMessageChannel[] {
  return apiChannels.map(mapApiChannelToClient);
}

// Map API Message to UiMessage
export function mapApiMessageToUi(apiMessage: ApiMessage, serverId?: UUID): UiMessage {
  // Ensure attachments are properly typed as Media[]
  const attachments =
    apiMessage.metadata?.attachments?.map((att: unknown): Media => {
      // Type guard for attachment-like objects
      if (typeof att !== 'object' || att === null) {
        throw new Error('Invalid attachment format');
      }
      const attachment = att as Record<string, unknown>;
      return {
        id: typeof attachment.id === 'string' ? attachment.id : crypto.randomUUID(),
        url: typeof attachment.url === 'string' ? attachment.url : '',
        title:
          typeof attachment.title === 'string'
            ? attachment.title
            : typeof attachment.name === 'string'
              ? attachment.name
              : undefined,
        source: typeof attachment.source === 'string' ? attachment.source : undefined,
        description:
          typeof attachment.description === 'string' ? attachment.description : undefined,
        text: typeof attachment.text === 'string' ? attachment.text : undefined,
        contentType: (typeof attachment.contentType === 'string'
          ? attachment.contentType
          : typeof attachment.type === 'string'
            ? attachment.type
            : undefined) as Media['contentType'],
      };
    }) || undefined;

  const messageType = apiMessage.sourceType;
  const rawMessage = apiMessage.rawMessage;
  return {
    id: apiMessage.id as UUID,
    text: apiMessage.content,
    name: apiMessage.metadata?.authorDisplayName || apiMessage.metadata?.agentName || 'Unknown',
    senderId: apiMessage.authorId as UUID,
    isAgent: Boolean(apiMessage.metadata?.isAgent) || false,
    createdAt: apiDateToTimestamp(apiMessage.createdAt),
    channelId: apiMessage.channelId as UUID,
    serverId: serverId || (apiMessage.metadata?.serverId as UUID),
    prompt: apiMessage.metadata?.prompt,
    attachments,
    thought: apiMessage.metadata?.thought,
    actions: apiMessage.metadata?.actions,
    type: messageType,
    rawMessage: rawMessage,
  };
}

// Map API AgentLog to client format
export function mapApiLogToClient(apiLog: ApiAgentLog): AgentLog {
  return {
    id: apiLog.id,
    type: apiLog?.type || apiLog.body?.modelType,
    timestamp: apiLog.timestamp ? apiDateToTimestamp(apiLog.timestamp) : undefined,
    message: apiLog.message,
    details: apiLog.details,
    roomId: apiLog.roomId,
    body: apiLog.body as AgentLogBody,
    createdAt: apiLog.createdAt ? apiDateToTimestamp(apiLog.createdAt) : undefined,
  };
}

// Body type for AgentLog
export interface AgentLogBody {
  modelType?: string;
  modelKey?: string;
  action?: string;
  actionId?: string;
  params?: Record<string, unknown> & { prompt?: string };
  prompts?: Array<{ name?: string; content?: string; modelType?: string; prompt?: string }>;
  promptCount?: number;
  response?:
    | string
    | {
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
        [key: string]: unknown;
      };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

// Type for client-side AgentLog
export interface AgentLog {
  id?: UUID;
  type?: string;
  timestamp?: number;
  message?: string;
  details?: string;
  roomId?: UUID;
  body?: AgentLogBody;
  createdAt?: number;
}

// Map API Memory to client Memory
export function mapApiMemoryToClient(apiMemory: ApiMemory): Memory {
  // Extract entityId from available sources, fallback to agentId if none available
  const entityId = (apiMemory.entityId ||
    apiMemory.metadata?.entityId ||
    apiMemory.metadata?.userId ||
    apiMemory.agentId) as UUID;

  return {
    id: apiMemory.id as UUID,
    entityId,
    agentId: apiMemory.agentId as UUID,
    content: apiMemory.content as Memory['content'],
    embedding: apiMemory.embedding,
    roomId: apiMemory.roomId as UUID,
    createdAt: apiDateToTimestamp(apiMemory.createdAt),
    unique: apiMemory.metadata?.unique as boolean | undefined,
  };
}
