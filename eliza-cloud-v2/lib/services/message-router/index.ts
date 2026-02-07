/**
 * Message Router Service
 *
 * Routes incoming messages from SMS/iMessage/Voice webhooks to the appropriate agent
 * and handles sending responses back through the correct channel.
 */

import { createHash } from "crypto";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { agentPhoneNumbers, phoneMessageLog } from "@/db/schemas";
import { eq, and } from "drizzle-orm";
import { logger } from "@/lib/utils/logger";
import { normalizePhoneNumber } from "@/lib/utils/phone-normalization";

/**
 * Schema for message metadata - allows simple key-value pairs only.
 * Prevents deeply nested or malicious objects from being stored.
 */
const messageMetadataSchema = z.record(
  z.string(),
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string(), z.number(), z.boolean()])),
  ])
).optional();

// Maximum metadata size to prevent DoS via large payloads (10KB)
const MAX_METADATA_SIZE = 10 * 1024;

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
      logger.warn('[MessageRouter] Metadata too large, truncating', {
        size: serialized.length,
        maxSize: MAX_METADATA_SIZE,
      });
      return {};
    }

    return parsed;
  } catch (error) {
    logger.warn('[MessageRouter] Invalid metadata format, using empty object', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return {};
  }
}

export interface IncomingMessage {
  from: string;
  to: string;
  body: string;
  provider: "twilio" | "blooio";
  providerMessageId?: string;
  mediaUrls?: string[];
  messageType?: "sms" | "mms" | "voice" | "imessage";
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
  provider: "twilio" | "blooio";
  mediaUrls?: string[];
  organizationId: string;
}

class MessageRouterService {
  /**
   * Find the agent and phone number mapping for an incoming message
   */
  async routeIncomingMessage(
    message: IncomingMessage,
  ): Promise<MessageRouteResult> {
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
        // TODO: Phone-to-agent mapping will be added in next feature
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
   * Integrates with ElizaOS agent runtime via rooms and entities
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

      // Send message to agent via the standard interface
      const response = await agentsService.sendMessage({
        roomId,
        entityId,
        message: message.body,
        organizationId,
        streaming: false,
        attachments,
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
      logger.warn("[MessageRouter] Agent returned no response", { agentId, organizationId });
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
   * Generate a deterministic entity ID for a phone number
   */
  private generateEntityId(phoneNumber: string): string {
    const normalized = normalizePhoneNumber(phoneNumber);
    // Use a simple hash to create a UUID-like ID
    const hash = this.secureHash(normalized);
    return `phone-${hash}`;
  }

  /**
   * Generate a deterministic room ID for a phone conversation
   */
  private generateRoomId(agentId: string, from: string, to: string): string {
    const normalizedFrom = normalizePhoneNumber(from);
    const normalizedTo = normalizePhoneNumber(to);
    // Sort to ensure consistency regardless of direction
    const sorted = [normalizedFrom, normalizedTo].sort().join("-");
    const hash = this.secureHash(`${agentId}:${sorted}`);
    return `room-phone-${hash}`;
  }

  /**
   * Secure hash function for generating deterministic IDs
   * Uses SHA-256 for collision resistance and unpredictability
   */
  private secureHash(str: string): string {
    return createHash("sha256")
      .update(str)
      .digest("hex")
      .substring(0, 16);
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
      const accountSid = await secretsService.get(
        params.organizationId,
        TWILIO_ACCOUNT_SID,
      );
      const authToken = await secretsService.get(
        params.organizationId,
        TWILIO_AUTH_TOKEN,
      );

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
      const apiKey = await secretsService.get(
        params.organizationId,
        BLOOIO_API_KEY,
      );

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
        }
      );

      logger.info("[MessageRouter] Blooio message sent successfully");
      return true;
    } catch (error) {
      logger.error("[MessageRouter] Blooio send error", { error });
      return false;
    }
  }

  /**
   * Log a message to the phone_message_log table
   */
  private async logMessage(params: {
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

    const [log] = await dbWrite
      .insert(phoneMessageLog)
      .values({
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
      })
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
    await dbWrite
      .update(phoneMessageLog)
      .set({
        status: "responded",
        agent_response: response.text,
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
    provider: "twilio" | "blooio";
    phoneType?: "sms" | "voice" | "both" | "imessage";
    friendlyName?: string;
    capabilities?: {
      canSendSms?: boolean;
      canReceiveSms?: boolean;
      canSendMms?: boolean;
      canReceiveMms?: boolean;
      canVoice?: boolean;
    };
  }): Promise<{ id: string; webhookUrl: string }> {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
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
