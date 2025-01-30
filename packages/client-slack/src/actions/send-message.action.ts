import type { SlackClientContext, SlackMessage } from "../types/slack-types";
import { elizaLogger } from "@elizaos/core";

// Cache to store recently sent messages
const recentMessages = new Map<string, { text: string; timestamp: number }>();
const MESSAGE_CACHE_TTL = 5000; // 5 seconds TTL

export class SendMessageAction {
    constructor(private context: SlackClientContext) {}

    private cleanupOldMessages() {
        const now = Date.now();
        for (const [key, value] of recentMessages.entries()) {
            if (now - value.timestamp > MESSAGE_CACHE_TTL) {
                recentMessages.delete(key);
            }
        }
    }

    private isDuplicate(message: SlackMessage): boolean {
        this.cleanupOldMessages();

        // Create a unique key for the message
        const messageKey = `${message.channelId}:${message.threadTs || "main"}:${message.text}`;

        // Check if we've seen this message recently
        const recentMessage = recentMessages.get(messageKey);
        if (recentMessage) {
            return true;
        }

        // Store the new message
        recentMessages.set(messageKey, {
            text: message.text,
            timestamp: Date.now(),
        });

        return false;
    }

    public async execute(message: SlackMessage): Promise<boolean> {
        try {
            // Skip duplicate messages
            if (this.isDuplicate(message)) {
                elizaLogger.debug("Skipping duplicate message:", message.text);
                return true; // Return true to indicate "success" since we're intentionally skipping
            }

            const result = await this.context.client.chat.postMessage({
                channel: message.channelId,
                text: message.text,
                thread_ts: message.threadTs,
            });

            return result.ok === true;
        } catch (error) {
            console.error("Failed to send message:", error);
            return false;
        }
    }
}
