import type { WhatsAppClient } from "../client";
import type { WhatsAppWebhookEvent } from "../types";

export class WebhookHandler {
    constructor(private client: WhatsAppClient) {}

    async handle(event: WhatsAppWebhookEvent): Promise<void> {
        try {
            // Process messages
            if (event.entry?.[0]?.changes?.[0]?.value?.messages) {
                const messages = event.entry[0].changes[0].value.messages;
                for (const message of messages) {
                    await this.handleMessage(message);
                }
            }

            // Process status updates
            if (event.entry?.[0]?.changes?.[0]?.value?.statuses) {
                const statuses = event.entry[0].changes[0].value.statuses;
                for (const status of statuses) {
                    await this.handleStatus(status);
                }
            }
        } catch (error: unknown) {
            if (error instanceof Error) {
                throw new Error(
                    `Failed to send WhatsApp message: ${error.message}`
                );
            }
            throw new Error("Failed to send WhatsApp message");
        }
    }

    private async handleMessage(message: any): Promise<void> {
        // Implement message handling logic
        // This could emit events or trigger callbacks based on your framework's needs
        console.log("Received message:", message);
    }

    private async handleStatus(status: any): Promise<void> {
        // Implement status update handling logic
        // This could emit events or trigger callbacks based on your framework's needs
        console.log("Received status update:", status);
    }
}
