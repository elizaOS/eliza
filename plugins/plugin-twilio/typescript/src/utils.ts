import { logger } from "@elizaos/core";
import { TWILIO_CONSTANTS } from "./constants";

/**
 * Validates a phone number in E.164 format
 * @param phoneNumber The phone number to validate
 * @returns true if valid, false otherwise
 */
export function validatePhoneNumber(phoneNumber: string): boolean {
  // E.164 format: +[country code][area code][phone number]
  // Example: +18885551212
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(phoneNumber);
}

/**
 * Validates a messaging address for SMS/WhatsApp.
 * Accepts E.164 or WhatsApp-prefixed addresses.
 * @param address The address to validate
 * @returns true if valid, false otherwise
 */
export function validateMessagingAddress(address: string): boolean {
  const messagingRegex = /^(whatsapp:)?\+[1-9]\d{1,14}$/;
  return messagingRegex.test(address);
}

/**
 * Determine if an address is a WhatsApp address.
 */
export function isWhatsAppAddress(address: string): boolean {
  return address.startsWith("whatsapp:");
}

/**
 * Remove WhatsApp prefix if present.
 */
export function stripWhatsAppPrefix(address: string): string {
  return isWhatsAppAddress(address) ? address.slice("whatsapp:".length) : address;
}

/**
 * Format a messaging address, preserving WhatsApp prefix if provided.
 */
export function formatMessagingAddress(
  address: string,
  defaultCountryCode: string = "+1"
): string | null {
  const hasPrefix = isWhatsAppAddress(address);
  const formatted = formatPhoneNumber(stripWhatsAppPrefix(address), defaultCountryCode);
  if (!formatted) {
    return null;
  }
  return hasPrefix ? `whatsapp:${formatted}` : formatted;
}

/**
 * Formats a phone number to E.164 format if possible
 * @param phoneNumber The phone number to format
 * @param defaultCountryCode The default country code to use if not provided
 * @returns The formatted phone number or null if invalid
 */
export function formatPhoneNumber(
  phoneNumber: string,
  defaultCountryCode: string = "+1"
): string | null {
  // Remove all non-numeric characters except +
  let cleaned = phoneNumber.replace(/[^\d+]/g, "");

  // If it doesn't start with +, add the default country code
  if (!cleaned.startsWith("+")) {
    // If it starts with the country code without +, add the +
    if (cleaned.startsWith("1") && cleaned.length === 11) {
      cleaned = "+" + cleaned;
    } else if (cleaned.length === 10) {
      // Assume it's a US number without country code
      cleaned = defaultCountryCode + cleaned;
    } else {
      return null;
    }
  }

  // Validate the formatted number
  if (validatePhoneNumber(cleaned)) {
    return cleaned;
  }

  return null;
}

/**
 * Generates TwiML for various scenarios
 */
export const generateTwiML = {
  /**
   * Generates TwiML for a simple voice response
   * @param message The message to say
   * @param voice The voice to use (default: alice)
   * @returns TwiML string
   */
  say: (message: string, voice: string = "alice"): string => {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${voice}">${escapeXml(message)}</Say>
</Response>`;
  },

  /**
   * Generates TwiML for gathering input
   * @param prompt The prompt message
   * @param options Gather options
   * @returns TwiML string
   */
  gather: (
    prompt: string,
    options: {
      numDigits?: number;
      timeout?: number;
      action?: string;
      method?: string;
    } = {}
  ): string => {
    const { numDigits = 1, timeout = 5, action = "", method = "POST" } = options;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather numDigits="${numDigits}" timeout="${timeout}" action="${action}" method="${method}">
        <Say>${escapeXml(prompt)}</Say>
    </Gather>
</Response>`;
  },

  /**
   * Generates TwiML for starting a media stream
   * @param streamUrl The WebSocket URL for streaming
   * @param customParameters Optional custom parameters
   * @returns TwiML string
   */
  stream: (streamUrl: string, customParameters?: Record<string, string>): string => {
    let params = "";
    if (customParameters) {
      params = Object.entries(customParameters)
        .map(([key, value]) => `<Parameter name="${key}" value="${escapeXml(value)}" />`)
        .join("\n        ");
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Start>
        <Stream url="${streamUrl}">
            ${params}
        </Stream>
    </Start>
    <Say>Please wait while I connect you to the AI assistant.</Say>
    <Pause length="60"/>
</Response>`;
  },

  /**
   * Generates TwiML for recording a call
   * @param options Recording options
   * @returns TwiML string
   */
  record: (
    options: { maxLength?: number; timeout?: number; transcribe?: boolean; action?: string } = {}
  ): string => {
    const { maxLength = 3600, timeout = 5, transcribe = false, action = "" } = options;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Record maxLength="${maxLength}" timeout="${timeout}" transcribe="${transcribe}" action="${action}" />
</Response>`;
  },

  /**
   * Generates TwiML to hang up
   * @returns TwiML string
   */
  hangup: (): string => {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Hangup />
</Response>`;
  },
};

/**
 * Escapes XML special characters
 * @param str The string to escape
 * @returns The escaped string
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Parses media URLs from webhook data
 * @param webhookData The webhook data object
 * @param numMedia The number of media items
 * @returns Array of media objects
 */
export function parseMediaFromWebhook(
  webhookData: any,
  numMedia: number
): Array<{
  url: string;
  contentType: string;
  sid: string;
}> {
  const media: Array<{
    url: string;
    contentType: string;
    sid: string;
  }> = [];

  for (let i = 0; i < numMedia; i++) {
    const url = webhookData[`MediaUrl${i}`];
    const contentType = webhookData[`MediaContentType${i}`];

    if (url) {
      media.push({
        url,
        contentType: contentType || "unknown",
        sid: `media_${i}`,
      });
    }
  }

  return media;
}

/**
 * Extracts phone number from various formats
 * @param input The input string that may contain a phone number
 * @returns The extracted phone number or null
 */
export function extractPhoneNumber(input: string): string | null {
  const wantsWhatsApp = input.toLowerCase().includes("whatsapp:");

  // Try to find a phone number pattern
  const patterns = [
    /\+\d{1,15}/, // E.164 format
    /\(\d{3}\)\s*\d{3}-\d{4}/, // (555) 555-5555
    /\d{3}-\d{3}-\d{4}/, // 555-555-5555
    /\d{10,15}/, // Just digits
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) {
      const formatted = formatPhoneNumber(match[0]);
      if (formatted) {
        return wantsWhatsApp ? `whatsapp:${formatted}` : formatted;
      }
    }
  }

  return null;
}

/**
 * Validates webhook signature from Twilio
 * @param authToken The auth token
 * @param signature The X-Twilio-Signature header
 * @param url The full URL of the webhook
 * @param params The request parameters
 * @returns true if valid, false otherwise
 */
export function validateWebhookSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  try {
    // Note: In production, you should use the twilio.validateRequest method
    // This is a simplified version for demonstration
    logger.warn("Webhook signature validation not fully implemented");
    return true; // TODO: Implement proper validation
  } catch (error) {
    logger.error({ error: String(error) }, "Error validating webhook signature");
    return false;
  }
}

/**
 * Chunks text for SMS messages (respecting 160 character limit)
 * @param text The text to chunk
 * @param maxLength Maximum length per chunk (default: 160)
 * @returns Array of text chunks
 */
export function chunkTextForSms(text: string, maxLength: number = 160): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  const words = text.split(" ");
  let currentChunk = "";

  for (const word of words) {
    if ((currentChunk + " " + word).trim().length <= maxLength) {
      currentChunk = (currentChunk + " " + word).trim();
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      currentChunk = word;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Converts audio buffer between formats
 * @param audioBuffer The audio buffer to convert
 * @param fromFormat The source format
 * @param toFormat The target format
 * @returns The converted audio buffer
 */
export async function convertAudioFormat(
  audioBuffer: Buffer,
  fromFormat: string,
  toFormat: string
): Promise<Buffer> {
  // TODO: Implement audio conversion using fluent-ffmpeg
  logger.warn("Audio conversion not implemented yet");
  return audioBuffer;
}

/**
 * Generates a webhook URL for a specific path
 * @param baseUrl The base webhook URL
 * @param path The path to append
 * @returns The full webhook URL
 */
export function getWebhookUrl(baseUrl: string, path: string): string {
  // Ensure base URL doesn't end with / and path starts with /
  const cleanBase = baseUrl.replace(/\/$/, "");
  const cleanPath = path.startsWith("/") ? path : "/" + path;
  return cleanBase + cleanPath;
}
