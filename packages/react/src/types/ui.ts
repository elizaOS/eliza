/**
 * UI-specific types for ElizaOS React
 */

import type { Message } from '@elizaos/api-client';
import type { UUID } from '@elizaos/core';

/**
 * UI Message type - extends Message with UI-specific properties for chat interfaces
 */
export interface UiMessage {
    id: UUID;
    agentId?: UUID;
    roomId?: UUID;
    userId?: UUID;
    channelId?: UUID;
    senderId?: UUID;
    text?: string;
    name?: string;
    source?: string;
    serverId?: UUID;
    prompt?: string;
    type?: 'user' | 'agent' | 'system' | 'agent_action';
    thought?: string | boolean;
    actions?: string[];
    content?: string | {
        text?: string;
        action?: string;
        source?: string;
        attachments?: Array<{ url?: string; title?: string; description?: string; contentType?: string }>;
        inReplyTo?: UUID;
    };
    attachments?: Array<{ id?: string; url?: string; title?: string; description?: string; contentType?: string }>;
    createdAt?: number;
    updatedAt?: number;
    authorId?: UUID;
    rawMessage?: Message;
    isOptimistic?: boolean;
    isLoading?: boolean;
    isAgent?: boolean;
    actionStatus?: 'pending' | 'executing' | 'running' | 'completed' | 'success' | 'failed' | 'error';
}

