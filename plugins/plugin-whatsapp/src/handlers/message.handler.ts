import type { WhatsAppClient } from "../client";
import type { WhatsAppMessage } from "../types";

export class MessageHandler {
    constructor(private client: WhatsAppClient) {}

    async send(message: WhatsAppMessage): Promise<any> {
        try {
            const response = await this.client.sendMessage(message);
            return response.data;
        } catch (error: unknown) {
            if (error instanceof Error) {
                throw new Error(
                    `Failed to send WhatsApp message: ${error.message}`
                );
            }
            throw new Error("Failed to send WhatsApp message");
        }
    }
}
