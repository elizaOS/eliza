/**
 * Message Router Service
 *
 * Routes incoming messages from SMS/iMessage/Voice webhooks to the appropriate agent
 * and handles sending responses back through the correct channel.
 */

import { createHash, randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { agentPhoneNumbers, type NewPhoneMessageLog, phoneMessageLog } from "@/db/schemas";
import { ObjectNamespaces } from "@/lib/storage/object-namespace";
import { offloadTextField } from "@/lib/storage/object-store";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";

/**
 * Schema for message metadata - allows simple key-value pairs only.
 * Prevents deeply nested or malicious objects from being stored.
 */
const messageMetadataSchema = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ]),
  )
  .optional();

// Maximum metadata size to prevent DoS via large payloads (10KB)
const MAX_METADATA_SIZE = 10 * 1024;

async function preparePhoneMessagePayload(
  data: NewPhoneMessageLog,
  organizationId: string,
): Promise<NewPhoneMessageLog> {
  if (
    data.message_body_storage === "r2" ||
    data.media_urls_storage === "r2" ||
    data.agent_response_storage === "r2" ||
    data.metadata_storage === "r2"
  ) {
    return data;
  }

  const id = data.id ?? randomUUID();
  const createdAt = data.created_at ?? new Date();
  const [messageBody, mediaUrls, agentResponse, metadata] = await Promise.all([
    offloadTextField({
      namespace: ObjectNamespaces.PhoneMessagePayloads,
      organizationId,
      objectId: id,
      field: "message_body",
      createdAt,
      value: data.message_body,
    }),
    offloadTextField({
      namespace: ObjectNamespaces.PhoneMessagePayloads,
      organizationId,
      objectId: id,
      field: "media_urls",
      createdAt,
      value: data.media_urls,
      inlineValueWhenOffloaded: "[]",
    }),
    offloadTextField({
      namespace: ObjectNamespaces.PhoneMessagePayloads,
      organizationId,
      objectId: id,
      field: "agent_response",
      createdAt,
      value: data.agent_response,
    }),
    offloadTextField({
      namespace: ObjectNamespaces.PhoneMessagePayloads,
      organizationId,
      objectId: id,
      field: "metadata",
      createdAt,
      value: data.metadata,
      inlineValueWhenOffloaded: "{}",
    }),
  ]);

  return {
    ...data,
    id,
    created_at: createdAt,
    message_body: messageBody.value,
    message_body_storage: messageBody.storage,
    message_body_key: messageBody.key,
    media_urls: mediaUrls.value,
    media_urls_storage: mediaUrls.storage,
    media_urls_key: mediaUrls.key,
    agent_response: agentResponse.value,
    agent_response_storage: agentResponse.storage,
    agent_response_key: agentResponse.key,
    metadata: metadata.value,
    metadata_storage: metadata.storage,
    metadata_key: metadata.key,
  };
}

/**
 * Helper to validate and sanitize metadata before storage
 */
function validateMetadata(metadata: unknown): Record<string, unknown> | undefined {
  if (!metadata) return undefined;

  try {
    const parsed = messageMetadataSchema.parse(metadata);

    // Check size to prevent DoS
    const serialized = JSON.stringify(parsed);
    if (serialized.length > MAX_METADATA_SIZE) {
      logger.warn("[MessageRouter] Metadata too large, truncating", {
        size: serialized.length,
        maxSize: MAX_METADATA_SIZE,
      });
      return {};
    }

    return parsed;
  } catch (error) {
    logger.warn("[MessageRouter] Invalid metadata format, using empty object", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {};
  }
}

export interface IncomingMessage {
  from: string;
  to: string;
  body: string;
  provider: "twilio" | "blooio" | "whatsapp";
  providerMessageId?: string;
  mediaUrls?: string[];
  messageType?: "sms" | "mms" | "voice" | "imessage" | "whatsapp";
  metadata?: Record<string, unknown>;
}

export interface MessageRouteResult {
  success: boolean;
  agentId?: string;
  phoneNumberId?: string;
  organizationId?: string;
  error?: string;
}

export interface AgentResponse {
  text: string;
  mediaUrls?: string[];
  metadata?: Record<string, unknown>;
}

export interface SendMessageParams {
  to: string;
  from: string;
  body: string;
  provider: "twilio" | "blooio" | "whatsapp";
  mediaUrls?: string[];
  organizationId: string;
}

class MessageRouterService {
  /**
   * Find the agent and phone number mapping for an incoming message
   */
  async routeIncomingMessage(message: IncomingMessage): Promise<MessageRouteResult> {
    try {
      logger.info("[MessageRouter] Routing incoming message", {
        from: message.from,
        to: message.to,
        provider: message.provider,
      });

      // Find the phone number mapping by the "to" number (our number)
      const phoneMapping = await dbWrite
        .select()
        .from(agentPhoneNumbers)
        .where(
          and(
            eq(agentPhoneNumbers.phone_number, normalizePhoneNumber(message.to)),
            eq(agentPhoneNumbers.is_active, true),
          ),
        )
        .limit(1);

      if (phoneMapping.length === 0) {
        logger.debug("[MessageRouter] No phone number mapping found", {
          to: message.to,
        });
        return {
          success: false,
          error: `No agent configured for phone number: ${message.to}`,
        };
      }

      const mapping = phoneMapping[0];

      // Log the incoming message
      await this.logMessage({
        organizationId: mapping.organization_id,
        phoneNumberId: mapping.id,
        direction: "inbound",
        from: message.from,
        to: message.to,
        body: message.body,
        messageType: message.messageType || "sms",
        providerMessageId: message.providerMessageId,
        mediaUrls: message.mediaUrls,
        metadata: message.metadata,
      });

      // Update last_message_at
      await dbWrite
        .update(agentPhoneNumbers)
        .set({ last_message_at: new Date(), updated_at: new Date() })
        .where(eq(agentPhoneNumbers.id, mapping.id));

      logger.info("[MessageRouter] Message routed to agent", {
        agentId: mapping.agent_id,
        phoneNumberId: mapping.id,
        organizationId: mapping.organization_id,
      });

      return {
        success: true,
        agentId: mapping.agent_id,
        phoneNumberId: mapping.id,
        organizationId: mapping.organization_id,
      };
    } catch (error) {
      logger.error("[MessageRouter] Error routing message", { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Process a message with an agent and get a response
   * Integrates with elizaOS agent runtime via rooms and entities
   */
  async processWithAgent(
    agentId: string,
    organizationId: string,
    message: IncomingMessage,
  ): Promise<AgentResponse | null> {
    try {
      logger.info("[MessageRouter] Processing message with agent", {
        agentId,
        message: message.body.substring(0, 100),
      });

      // Import services dynamically to avoid circular deps
      const { agentsService } = await import("@/lib/services/agents/agents");
      const { roomsService } = await import("@/lib/services/agents/rooms");

      // Generate deterministic IDs for room and entity based on phone numbers
      // This ensures the same conversation always uses the same room
      const entityId = this.generateEntityId(message.from);
      const roomId = this.generateRoomId(agentId, message.from, message.to);

      // Check if room exists, if not create it
      const existingRoom = await this.findExistingRoom(roomId);
      if (!existingRoom) {
        logger.info("[MessageRouter] Creating new room for phone conversation", {
          roomId,
          agentId,
          from: message.from,
          to: message.to,
        });

        await roomsService.createRoom({
          id: roomId,
          agentId,
          entityId,
          source: message.provider,
          type: "DM",
          name: `SMS: ${message.from}`,
          metadata: {
            channel: "phone",
            provider: message.provider,
            fromNumber: message.from,
            toNumber: message.to,
            organizationId,
          },
        });

        // Add the phone user as a participant
        await roomsService.addParticipant(roomId, entityId, agentId);
      }

      // Prepare attachments if any media URLs
      const attachments = message.mediaUrls?.map((url) => ({
        type: "image" as const,
        url,
      }));

      // Send message to agent via the standard interface.
      // Pass agentId as characterId so the runtime loads the correct character
      // (e.g., "Dr. Alex Chen") instead of the default "Eliza" agent.
      const response = await agentsService.sendMessage({
        roomId,
        entityId,
        message: message.body,
        organizationId,
        streaming: false,
        attachments,
        characterId: agentId,
      });

      if (response) {
        return {
          text: response.content || "",
          metadata: {
            messageId: response.messageId,
            timestamp: response.timestamp,
          },
        };
      }

      // Fallback if agent doesn't respond (e.g., agent returned null/empty)
      logger.warn("[MessageRouter] Agent returned no response", {
        agentId,
        organizationId,
      });
      return {
        text: "Thanks for your message! I'm processing it but couldn't generate a response. Please try again.",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("[MessageRouter] Error processing with agent", {
        error: errorMessage,
        agentId,
        organizationId,
      });

      // Return differentiated error messages based on error type
      if (errorMessage.includes("not found") || errorMessage.includes("not configured")) {
        return {
          text: "Sorry, this assistant is currently not available. Please contact support if the issue persists.",
        };
      }
      if (errorMessage.includes("timeout") || errorMessage.includes("ETIMEDOUT")) {
        return {
          text: "Sorry, the response is taking longer than expected. Please try again in a moment.",
        };
      }
      // Generic transient error
      return {
        text: "Sorry, I encountered a temporary issue. Please try again shortly.",
      };
    }
  }

  /**
   * Generate a deterministic entity ID for a phone number.
   * Returns a valid UUID derived from the phone number hash.
   */
  private generateEntityId(phoneNumber: string): string {
    const normalized = normalizePhoneNumber(phoneNumber);
    return this.hashToUuid(`entity:${normalized}`);
  }

  /**
   * Generate a deterministic room ID for a phone conversation.
   * Returns a valid UUID derived from the agent + phone numbers hash.
   */
  private generateRoomId(agentId: string, from: string, to: string): string {
    const normalizedFrom = normalizePhoneNumber(from);
    const normalizedTo = normalizePhoneNumber(to);
    // Sort to ensure consistency regardless of direction
    const sorted = [normalizedFrom, normalizedTo].sort().join("-");
    return this.hashToUuid(`room:${agentId}:${sorted}`);
  }

  /**
   * Generate a deterministic UUID from a string input.
   * Uses SHA-256 and formats the first 32 hex chars as a UUID v4-like string.
   * The version nibble is set to 4 and the variant bits to 10xx for RFC 4122 compliance.
   */
  private hashToUuid(str: string): string {
    const hex = createHash("sha256").update(str).digest("hex").substring(0, 32);
    // Format as UUID: 8-4-4-4-12
    // Set version nibble (position 12) to 4 and variant bits (position 16) to 8-b
    const chars = hex.split("");
    chars[12] = "4"; // version 4
    chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16); // variant 10xx
    return [
      chars.slice(0, 8).join(""),
      chars.slice(8, 12).join(""),
      chars.slice(12, 16).join(""),
      chars.slice(16, 20).join(""),
      chars.slice(20, 32).join(""),
    ].join("-");
  }

  /**
   * Check if a room exists
   */
  private async findExistingRoom(roomId: string): Promise<boolean> {
    try {
      const { roomsRepository } = await import("@/db/repositories");
      const room = await roomsRepository.findById(roomId);
      return room !== null;
    } catch {
      return false;
    }
  }

  /**
   * Send a message through the appropriate provider
   */
  async sendMessage(params: SendMessageParams): Promise<boolean> {
    try {
      logger.info("[MessageRouter] Sending message", {
        to: params.to,
        from: params.from,
        provider: params.provider,
      });

      if (params.provider === "twilio") {
        return await this.sendViaTwilio(params);
      } else if (params.provider === "blooio") {
        return await this.sendViaBlooio(params);
      } else if (params.provider === "whatsapp") {
        return await this.sendViaWhatsApp(params);
      }

      logger.error("[MessageRouter] Unknown provider", {
        provider: params.provider,
      });
      return false;
    } catch (error) {
      logger.error("[MessageRouter] Error sending message", { error });
      return false;
    }
  }

  /**
   * Send message via Twilio
   */
  private async sendViaTwilio(params: SendMessageParams): Promise<boolean> {
    try {
      const { secretsService } = await import("@/lib/services/secrets");

      // Use secretsService.get() which looks up by (organizationId, secretName)
      // Note: getDecryptedValue() takes (secretId, organizationId) - different signature
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = await import("@/lib/constants/secrets");
      const accountSid = await secretsService.get(params.organizationId, TWILIO_ACCOUNT_SID);
      const authToken = await secretsService.get(params.organizationId, TWILIO_AUTH_TOKEN);

      if (!accountSid || !authToken) {
        logger.error("[MessageRouter] Missing Twilio credentials");
        return false;
      }

      // Twilio REST API
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            To: params.to,
            From: params.from,
            Body: params.body,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error("[MessageRouter] Twilio API error", { error });
        return false;
      }

      logger.info("[MessageRouter] Twilio message sent successfully");
      return true;
    } catch (error) {
      logger.error("[MessageRouter] Twilio send error", { error });
      return false;
    }
  }

  /**
   * Send message via Blooio (iMessage)
   */
  private async sendViaBlooio(params: SendMessageParams): Promise<boolean> {
    try {
      const { secretsService } = await import("@/lib/services/secrets");
      const { blooioApiRequest } = await import("@/lib/utils/blooio-api");

      // Use secretsService.get() which looks up by (organizationId, secretName)
      const { BLOOIO_API_KEY } = await import("@/lib/constants/secrets");
      const apiKey = await secretsService.get(params.organizationId, BLOOIO_API_KEY);

      if (!apiKey) {
        logger.error("[MessageRouter] Missing Blooio API key");
        return false;
      }

      // Use the blooioApiRequest helper which uses the correct API base URL
      await blooioApiRequest(
        apiKey,
        "POST",
        `/chats/${encodeURIComponent(params.to)}/messages`,
        {
          text: params.body,
          attachments: params.mediaUrls,
        },
        {
          fromNumber: params.from,
        },
      );

      logger.info("[MessageRouter] Blooio message sent successfully");
      return true;
    } catch (error) {
      logger.error("[MessageRouter] Blooio send error", { error });
      return false;
    }
  }

  /**
   * Send message via WhatsApp Cloud API.
   * Tries org-specific credentials from secrets service first,
   * falls back to global elizaAppConfig for the public bot.
   */
  private async sendViaWhatsApp(params: SendMessageParams): Promise<boolean> {
    try {
      const { sendWhatsAppMessage } = await import("@/lib/utils/whatsapp-api");
      const { secretsService } = await import("@/lib/services/secrets");
      const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = await import(
        "@/lib/constants/secrets"
      );

      // Try org-specific credentials first (from secrets service)
      let accessToken = await secretsService.get(params.organizationId, WHATSAPP_ACCESS_TOKEN);
      let phoneNumberId = await secretsService.get(params.organizationId, WHATSAPP_PHONE_NUMBER_ID);

      // Fall back to global config (for eliza-app public bot)
      if (!accessToken || !phoneNumberId) {
        const { elizaAppConfig } = await import("@/lib/services/eliza-app/config");
        accessToken = accessToken || elizaAppConfig.whatsapp.accessToken;
        phoneNumberId = phoneNumberId || elizaAppConfig.whatsapp.phoneNumberId;
      }

      if (!accessToken || !phoneNumberId) {
        logger.error("[MessageRouter] Missing WhatsApp credentials", {
          organizationId: params.organizationId,
        });
        return false;
      }

      await sendWhatsAppMessage(accessToken, phoneNumberId, params.to, params.body);

      logger.info("[MessageRouter] WhatsApp message sent successfully", {
        organizationId: params.organizationId,
      });
      return true;
    } catch (error) {
      logger.error("[MessageRouter] WhatsApp send error", {
        organizationId: params.organizationId,
        error,
      });
      return false;
    }
  }

  /**
   * Log a message to the phone_message_log table
   */
  private async logMessage(params: {
    organizationId: string;
    phoneNumberId: string;
    direction: "inbound" | "outbound";
    from: string;
    to: string;
    body?: string;
    messageType: string;
    providerMessageId?: string;
    mediaUrls?: string[];
    metadata?: Record<string, unknown>;
    status?: string;
    agentResponse?: string;
    responseTimeMs?: number;
  }): Promise<string> {
    // Validate metadata to prevent malicious nested objects
    const validatedMetadata = validateMetadata(params.metadata);

    // Normalize phone numbers to prevent SQL injection via malformed data
    // This ensures only valid E.164 formatted numbers are stored
    const normalizedFrom = normalizePhoneNumber(params.from);
    const normalizedTo = normalizePhoneNumber(params.to);

    const insertData = await preparePhoneMessagePayload(
      {
        phone_number_id: params.phoneNumberId,
        direction: params.direction,
        from_number: normalizedFrom,
        to_number: normalizedTo,
        message_body: params.body,
        message_type: params.messageType,
        provider_message_id: params.providerMessageId,
        media_urls: params.mediaUrls ? JSON.stringify(params.mediaUrls) : null,
        metadata: validatedMetadata ? JSON.stringify(validatedMetadata) : "{}",
        status: params.status || "received",
        agent_response: params.agentResponse,
        response_time_ms: params.responseTimeMs?.toString(),
      },
      params.organizationId,
    );

    const [log] = await dbWrite
      .insert(phoneMessageLog)
      .values(insertData)
      .returning({ id: phoneMessageLog.id });

    return log.id;
  }

  /**
   * Update message log with agent response
   */
  async updateMessageLog(
    messageLogId: string,
    response: AgentResponse,
    responseTimeMs: number,
  ): Promise<void> {
    const [context] = await dbWrite
      .select({
        organizationId: agentPhoneNumbers.organization_id,
        createdAt: phoneMessageLog.created_at,
      })
      .from(phoneMessageLog)
      .innerJoin(agentPhoneNumbers, eq(phoneMessageLog.phone_number_id, agentPhoneNumbers.id))
      .where(eq(phoneMessageLog.id, messageLogId))
      .limit(1);

    const agentResponse = context
      ? await offloadTextField({
          namespace: ObjectNamespaces.PhoneMessagePayloads,
          organizationId: context.organizationId,
          objectId: messageLogId,
          field: "agent_response",
          createdAt: context.createdAt,
          value: response.text,
        })
      : null;

    await dbWrite
      .update(phoneMessageLog)
      .set({
        status: "responded",
        agent_response: agentResponse?.value ?? response.text,
        ...(agentResponse
          ? {
              agent_response_storage: agentResponse.storage,
              agent_response_key: agentResponse.key,
            }
          : {}),
        response_time_ms: responseTimeMs.toString(),
        responded_at: new Date(),
      })
      .where(eq(phoneMessageLog.id, messageLogId));
  }

  /**
   * Mark message as failed
   */
  async markMessageFailed(messageLogId: string, error: string): Promise<void> {
    await dbWrite
      .update(phoneMessageLog)
      .set({
        status: "failed",
        error_message: error,
      })
      .where(eq(phoneMessageLog.id, messageLogId));
  }

  /**
   * Register a phone number for an agent
   */
  async registerPhoneNumber(params: {
    organizationId: string;
    agentId: string;
    phoneNumber: string;
    provider: "twilio" | "blooio" | "whatsapp";
    phoneType?: "sms" | "voice" | "both" | "imessage" | "whatsapp";
    friendlyName?: string;
    capabilities?: {
      canSendSms?: boolean;
      canReceiveSms?: boolean;
      canSendMms?: boolean;
      canReceiveMms?: boolean;
      canVoice?: boolean;
    };
  }): Promise<{ id: string; webhookUrl: string }> {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";
    const webhookUrl = `${baseUrl}/api/webhooks/${params.provider}/${params.organizationId}`;

    const [record] = await dbWrite
      .insert(agentPhoneNumbers)
      .values({
        organization_id: params.organizationId,
        agent_id: params.agentId,
        phone_number: normalizePhoneNumber(params.phoneNumber),
        friendly_name: params.friendlyName,
        provider: params.provider,
        phone_type: params.phoneType || "sms",
        webhook_url: webhookUrl,
        can_send_sms: params.capabilities?.canSendSms ?? true,
        can_receive_sms: params.capabilities?.canReceiveSms ?? true,
        can_send_mms: params.capabilities?.canSendMms ?? false,
        can_receive_mms: params.capabilities?.canReceiveMms ?? false,
        can_voice: params.capabilities?.canVoice ?? false,
      })
      .returning({ id: agentPhoneNumbers.id });

    logger.info("[MessageRouter] Phone number registered", {
      id: record.id,
      phoneNumber: params.phoneNumber,
      agentId: params.agentId,
      webhookUrl,
    });

    return { id: record.id, webhookUrl };
  }

  /**
   * Get all phone numbers for an organization
   */
  async getPhoneNumbers(organizationId: string) {
    return dbWrite
      .select()
      .from(agentPhoneNumbers)
      .where(eq(agentPhoneNumbers.organization_id, organizationId));
  }

  /**
   * Get phone number by ID
   */
  async getPhoneNumberById(id: string) {
    const [record] = await dbWrite
      .select()
      .from(agentPhoneNumbers)
      .where(eq(agentPhoneNumbers.id, id))
      .limit(1);

    return record || null;
  }

  /**
   * Deactivate a phone number
   */
  async deactivatePhoneNumber(id: string): Promise<void> {
    await dbWrite
      .update(agentPhoneNumbers)
      .set({ is_active: false, updated_at: new Date() })
      .where(eq(agentPhoneNumbers.id, id));
  }
}

export const messageRouterService = new MessageRouterService();
