import {
  Agent as ApiAgent,
  AgentLog as ApiAgentLog,
  Message as ApiMessage,
  MessageChannel as ApiMessageChannel,
  MessageServer as ApiMessageServer,
  Memory as ApiMemory,
} from '@elizaos/api-client';
import { Agent, AgentStatus, UUID, ChannelType, Memory } from '@elizaos/core';
import type {
  AgentWithStatus,
  MessageChannel as ClientMessageChannel,
  MessageServer as ClientMessageServer,
  ServerMessage,
} from '../types';
import type { UiMessage } from '../hooks/use-query-hooks';

// Map API Agent status strings to core AgentStatus enum
export function mapApiStatusToEnum(status: 'active' | 'inactive' | 'stopped'): AgentStatus {
  switch (status) {
    case 'active':
      return AgentStatus.ACTIVE;
    case 'inactive':
    case 'stopped': // Map stopped to inactive since core doesn't have STOPPED
      return AgentStatus.INACTIVE;
    default:
      return AgentStatus.INACTIVE;
  }
}

// Map core AgentStatus enum to API status strings
export function mapEnumToApiStatus(status: AgentStatus): 'active' | 'inactive' | 'stopped' {
  switch (status) {
    case AgentStatus.ACTIVE:
      return 'active';
    case AgentStatus.INACTIVE:
      return 'inactive';
    default:
      return 'inactive';
  }
}

// Convert API Agent to client AgentWithStatus
export function mapApiAgentToClient(apiAgent: ApiAgent): AgentWithStatus {
  return {
    ...apiAgent,
    id: apiAgent.id as UUID,
    status: mapApiStatusToEnum(apiAgent.status),
    createdAt:
      apiAgent.createdAt instanceof Date
        ? apiAgent.createdAt.getTime()
        : new Date(apiAgent.createdAt).getTime(),
    updatedAt:
      apiAgent.updatedAt instanceof Date
        ? apiAgent.updatedAt.getTime()
        : new Date(apiAgent.updatedAt).getTime(),
  } as AgentWithStatus;
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
    apiMessage.metadata?.attachments?.map((att: any) => ({
      id: att.id || crypto.randomUUID(),
      url: att.url,
      title: att.title || att.name,
      source: att.source,
      description: att.description,
      text: att.text,
      contentType: att.contentType || att.type,
    })) || undefined;

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
    body: apiLog.body,
    createdAt: apiLog.createdAt ? apiDateToTimestamp(apiLog.createdAt) : undefined,
  };
}

// Type for client-side AgentLog
export interface AgentLog {
  id?: UUID;
  type?: string;
  timestamp?: number;
  message?: string;
  details?: string;
  roomId?: UUID;
  body?: any;
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
    content: apiMemory.content,
    embedding: apiMemory.embedding,
    roomId: apiMemory.roomId as UUID,
    createdAt: apiDateToTimestamp(apiMemory.createdAt),
    unique: apiMemory.metadata?.unique,
  };
}
