import axios, { type AxiosInstance } from "axios";
import type { WhatsAppConfig, WhatsAppMessage } from "./types";

export class WhatsAppClient {
    private client: AxiosInstance;
    private config: WhatsAppConfig;

    constructor(config: WhatsAppConfig) {
        this.config = config;
        this.client = axios.create({
            baseURL: "https://graph.facebook.com/v17.0",
            headers: {
                Authorization: `Bearer ${config.accessToken}`,
                "Content-Type": "application/json",
            },
        });
    }

    async sendMessage(message: WhatsAppMessage): Promise<any> {
        const endpoint = `/${this.config.phoneNumberId}/messages`;

        const payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: message.to,
            type: message.type,
            ...(message.type === "text"
                ? { text: { body: message.content } }
                : { template: message.content }),
        };

        return this.client.post(endpoint, payload);
    }

    async verifyWebhook(token: string): Promise<boolean> {
        return token === this.config.webhookVerifyToken;
    }
}
