import type { WhatsAppMessage, WhatsAppTemplate, WhatsAppConfig } from "../types";

export function validateConfig(config: WhatsAppConfig): void {
    if (!config.accessToken) {
        throw new Error("WhatsApp access token is required");
    }
    if (!config.phoneNumberId) {
        throw new Error("WhatsApp phone number ID is required");
    }
}

export function validateMessage(message: WhatsAppMessage): void {
    if (!message.to) {
        throw new Error("Recipient phone number is required");
    }

    if (!message.type) {
        throw new Error("Message type is required");
    }

    if (!message.content) {
        throw new Error("Message content is required");
    }

    if (message.type === "template") {
        validateTemplate(message.content as WhatsAppTemplate);
    }
}

export function validateTemplate(template: WhatsAppTemplate): void {
    if (!template.name) {
        throw new Error("Template name is required");
    }

    if (!template.language || !template.language.code) {
        throw new Error("Template language code is required");
    }
}

export function validatePhoneNumber(phoneNumber: string): boolean {
    // Basic phone number validation - can be enhanced based on requirements
    const phoneRegex = /^\d{1,15}$/;
    return phoneRegex.test(phoneNumber);
}
