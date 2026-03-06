import type { Plugin } from '@elizaos/core';
import { WhatsAppClient } from './client';
import { MessageHandler, WebhookHandler } from './handlers';
import type {
    WhatsAppConfig,
    WhatsAppMessage,
    WhatsAppMessageResponse,
    WhatsAppWebhookEvent,
} from './types';
import { sendMessageAction, sendReactionAction } from './actions';

export class WhatsAppPlugin implements Plugin {
    private client: WhatsAppClient;
    private messageHandler: MessageHandler;
    private webhookHandler: WebhookHandler;

    name: string;
    description: string;
    actions = [sendMessageAction, sendReactionAction];

    constructor(config: WhatsAppConfig) {
        this.name = 'WhatsApp Cloud API Plugin';
        this.description = 'A plugin for integrating WhatsApp Cloud API with your application.';
        this.client = new WhatsAppClient(config);
        this.messageHandler = new MessageHandler(this.client);
        this.webhookHandler = new WebhookHandler(this.client);
    }

    async sendMessage(message: WhatsAppMessage): Promise<WhatsAppMessageResponse> {
        return this.messageHandler.send(message);
    }

    async handleWebhook(event: WhatsAppWebhookEvent): Promise<void> {
        return this.webhookHandler.handle(event);
    }

    async verifyWebhook(token: string): Promise<boolean> {
        return this.client.verifyWebhook(token);
    }
}

/**
 * Standard Eliza plugin export for runtime registration.
 */
const whatsappPlugin: Plugin = {
    name: 'whatsapp',
    description: 'WhatsApp Cloud API integration for elizaOS',
    actions: [sendMessageAction, sendReactionAction],
};

export default whatsappPlugin;

export * from './types';

// Channel configuration types
export type {
  WhatsAppAccountConfig,
  WhatsAppActionConfig,
  WhatsAppAckReactionConfig,
  WhatsAppChannelConfig,
  WhatsAppConfig,
  WhatsAppGroupConfig,
} from './config';

// Account management exports
export {
    checkWhatsAppUserAccess,
    DEFAULT_ACCOUNT_ID,
    isMultiAccountEnabled,
    isWhatsAppMentionRequired,
    isWhatsAppUserAllowed,
    listEnabledWhatsAppAccounts,
    listWhatsAppAccountIds,
    normalizeAccountId,
    resolveDefaultWhatsAppAccountId,
    resolveWhatsAppAccount,
    resolveWhatsAppGroupConfig,
    resolveWhatsAppToken,
    type ResolvedWhatsAppAccount,
    type WhatsAppAccessCheckResult,
    type WhatsAppAccountRuntimeConfig,
    type WhatsAppGroupRuntimeConfig,
    type WhatsAppMultiAccountConfig,
    type WhatsAppTokenResolution,
    type WhatsAppTokenSource,
} from './accounts';

// Normalization and utility exports
export {
    buildWhatsAppUserJid,
    chunkWhatsAppText,
    formatWhatsAppId,
    formatWhatsAppPhoneNumber,
    getWhatsAppChatType,
    isValidWhatsAppNumber,
    isWhatsAppGroup,
    isWhatsAppGroupJid,
    isWhatsAppUserTarget,
    normalizeE164,
    normalizeWhatsAppTarget,
    resolveWhatsAppSystemLocation,
    truncateText,
    WHATSAPP_TEXT_CHUNK_LIMIT,
    type ChunkWhatsAppTextOpts,
} from './normalize';
