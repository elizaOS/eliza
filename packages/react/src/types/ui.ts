/**
 * UI-specific types for ElizaOS React
 */

import type { Message } from '@elizaos/api-client';
import type { UUID } from '@elizaos/core';

/**
 * UI Message type - extends Message with UI-specific properties
 */
export interface UiMessage {
    id: UUID;
    agentId: UUID;
    roomId: UUID;
    userId: UUID;
    content: {
        text: string;
        action?: string;
        source?: string;
        attachments?: Array<{ url?: string; title?: string; description?: string; contentType?: string }>;
        inReplyTo?: UUID;
    };
    createdAt: number;
    rawMessage?: Message;
    isOptimistic?: boolean;
    actionStatus?: 'pending' | 'executing' | 'running' | 'completed' | 'success' | 'failed' | 'error';
}

