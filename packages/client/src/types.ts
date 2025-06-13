// Update the IAttachment interface

import { Agent, UUID } from '@elizaos/core';
import type {
  Agent as CoreAgent,
  Character as CoreCharacter,
  Room as CoreRoom,
  AgentStatus as CoreAgentStatus,
  ChannelType as CoreChannelType,
} from '@elizaos/core';

/**
 * Interface representing an attachment.
 * @interface
 * @property {string} url - The URL of the attachment.
 * @property {string} [contentType] - The content type of the attachment, optional.
 * @property {string} title - The title of the attachment.
 */
export interface IAttachment {
  url: string;
  contentType?: string; // Make contentType optional
  title: string;
}

// Agent type for client-side display, extending core Agent with a string status for UI flexibility if needed,
// but ideally aligns with CoreAgentStatus enum.
export interface AgentWithStatus extends Partial<CoreAgent> {
  id: UUID;
  name: string;
  characterName?: string; // From core Agent, which extends Character
  bio?: string | string[];
  status: CoreAgentStatus; // Use the enum from @elizaos/core
  settings?: CoreCharacter['settings']; // From core Character
  // any other client-specific properties
}

// Interface for agent panels (public routes)
export interface AgentPanel {
  name: string;
  path: string;
}

// Represents a server/guild in the central messaging system for the client
export interface MessageServer {
  id: UUID; // Global serverId
  name: string;
  sourceType: string;
  sourceId?: string;
  metadata?: Record<string, any>;
  createdAt: string; // ISO Date string from server, or Date object
  updatedAt: string; // ISO Date string from server, or Date object
}

// Represents a channel within a MessageServer for the client
export interface MessageChannel {
  id: UUID; // Global channelId
  messageServerId: UUID;
  name: string;
  type: CoreChannelType; // Using the enum from @elizaos/core
  sourceType?: string;
  sourceId?: string;
  topic?: string;
  metadata?: Record<string, any>;
  createdAt: string; // ISO Date string from server, or Date object
  updatedAt: string; // ISO Date string from server, or Date object
}

// Represents a message from the central system for client display
// This should align with what apiClient.getChannelMessages returns for each message
export interface ServerMessage {
  id: UUID;
  channelId: UUID;
  serverId?: UUID; // Optional: May be added during client-side processing or be in metadata
  authorId: UUID;
  authorDisplayName?: string; // Optional: May be in metadata or fetched separately
  content: string;
  createdAt: number; // Expecting timestamp MS for UI sorting/display
  rawMessage?: any;
  inReplyToRootMessageId?: UUID;
  sourceType?: string;
  sourceId?: string;
  metadata?: {
    agentName?: string;
    thought?: string;
    actions?: string[];
    attachments?: any[];
    authorDisplayName?: string; // If API puts it here
    serverId?: UUID; // If API puts it here
    prompt?: string; // Add prompt field to store the LLM prompt
    [key: string]: any;
  };
}
