import { isValidWhatsAppNumber } from "../normalize";
import type { WhatsAppConfig, WhatsAppMessage, WhatsAppTemplate } from "../types";

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

/**
 * Validates a WhatsApp phone number using robust E.164 format checking.
 * Requires at minimum 10 digits and validates against WhatsApp JID normalization rules.
 */
export function validatePhoneNumber(phoneNumber: string): boolean {
  return isValidWhatsAppNumber(phoneNumber);
}
