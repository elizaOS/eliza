export interface WhatsAppConfig {
    accessToken: string;
    phoneNumberId: string;
    webhookVerifyToken?: string;
    businessAccountId?: string;
}

export interface WhatsAppMessage {
    type: "text" | "template";
    to: string;
    content: string | WhatsAppTemplate;
}

export interface WhatsAppTemplate {
    name: string;
    language: {
        code: string;
    };
    components?: Array<{
        type: string;
        parameters: Array<{
            type: string;
            text?: string;
        }>;
    }>;
}

export interface WhatsAppWebhookEvent {
    object: string;
    entry: Array<{
        id: string;
        changes: Array<{
            value: {
                messaging_product: string;
                metadata: {
                    display_phone_number: string;
                    phone_number_id: string;
                };
                statuses?: Array<{
                    id: string;
                    status: string;
                    timestamp: string;
                    recipient_id: string;
                }>;
                messages?: Array<{
                    from: string;
                    id: string;
                    timestamp: string;
                    text?: {
                        body: string;
                    };
                    type: string;
                }>;
            };
            field: string;
        }>;
    }>;
}
