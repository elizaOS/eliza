/**
 * Message Router Service
 *
 * Routes incoming messages from SMS/iMessage/Voice webhooks to the appropriate agent
 * and handles sending responses back through the correct channel.
 */

import { ElizaError } from "@elizaos/core";
import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { dbWrite } from "../../../db/client";
import { phoneMessageLogsRepository } from "../../../db/repositories/phone-message-logs";
import {
  agentPhoneNumberLosslessSelection,
  hydrateAgentPhoneNumber,
} from "../../../db/repositories/phone-metadata-readers";
import { agentPhoneContacts } from "../../../db/schemas/agent-phone-contacts";
import { agentPhoneNumbers, type PhoneMessageLog } from "../../../db/schemas/agent-phone-numbers";
import { logger } from "../../utils/logger";
import { normalizePhoneNumber } from "../../utils/phone-normalization";
import {
  isPhoneMessagePersistenceFailure,
  isPhoneMessageRoutingUnavailable,
  isPostgresUndefinedTableError,
  PHONE_MESSAGE_PERSISTENCE_FAILED_CODE,
  PHONE_MESSAGE_ROUTING_UNAVAILABLE_CODE,
  phoneErrorDiagnostic,
} from "../phone-error-diagnostics";

function isUndefinedTableError(error: unknown): boolean {
  return isPostgresUndefinedTableError(error);
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
  agentId?: string;
  agentOrganizationId?: string;
  agentUserId?: string;
  contactDisplayName?: string;
}

function providerDiagnostic(value: unknown): string {
  return value === "twilio" || value === "blooio" || value === "whatsapp" ? value : "unknown";
}

class MessageRouterService {
  /**
   * Find the agent and phone number mapping for an incoming message
   */
  async routeIncomingMessage(message: IncomingMessage): Promise<MessageRouteResult> {
    try {
      logger.info("[MessageRouter] Routing incoming message", {
        provider: providerDiagnostic(message.provider),
      });

      // Find the phone number mapping by the "to" number (our number)
      const normalizedTo = normalizePhoneNumber(message.to);
      let phoneMapping: Array<{
        agent_id: string;
        id: string;
        organization_id: string;
      }>;
      try {
        phoneMapping = await dbWrite
          .select({
            agent_id: agentPhoneNumbers.agent_id,
            id: agentPhoneNumbers.id,
            organization_id: agentPhoneNumbers.organization_id,
          })
          .from(agentPhoneNumbers)
          .where(
            and(
              eq(agentPhoneNumbers.phone_number, normalizedTo),
              eq(agentPhoneNumbers.is_active, true),
            ),
          )
          .limit(1);
      } catch (cause) {
        throw new ElizaError("Phone message routing lookup is unavailable", {
          code: PHONE_MESSAGE_ROUTING_UNAVAILABLE_CODE,
          cause,
        });
      }

      if (phoneMapping.length === 0) {
        logger.debug("[MessageRouter] No phone number mapping found", {
          provider: providerDiagnostic(message.provider),
        });
        return {
          success: false,
          error: "No active phone routing configuration",
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
      try {
        await dbWrite
          .update(agentPhoneNumbers)
          .set({ last_message_at: new Date(), updated_at: new Date() })
          .where(eq(agentPhoneNumbers.id, mapping.id));
      } catch (error) {
        // error-policy:J6 the canonical message is already committed; this
        // denormalized timestamp must not trigger duplicate provider retries.
        logger.warn(
          "[MessageRouter] Last-message timestamp update failed after persistence",
          phoneErrorDiagnostic(error),
        );
      }

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
      logger.error("[MessageRouter] Error routing message", {
        provider: providerDiagnostic(message.provider),
        ...phoneErrorDiagnostic(error),
      });
      // error-policy:J2 a webhook must retry when its canonical message write did
      // not commit or when the authoritative lookup could not be completed.
      if (isPhoneMessagePersistenceFailure(error) || isPhoneMessageRoutingUnavailable(error)) {
        throw error;
      }
      // error-policy:J4 non-persistence routing failures are returned to the webhook boundary.
      return {
        success: false,
        error: "Message routing failed",
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
        organizationId,
        provider: providerDiagnostic(message.provider),
      });

      // Import services dynamically to avoid circular deps
      const { agentsService } = await import("../agents/agents");
      const { roomsService } = await import("../agents/rooms");

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
          organizationId,
          provider: providerDiagnostic(message.provider),
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
      // error-policy:J4 agent processing failures degrade to a bounded user-facing response.
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("[MessageRouter] Error processing with agent", {
        ...phoneErrorDiagnostic(error),
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
      const { roomsRepository } = await import("../../../db/repositories");
      const room = await roomsRepository.findById(roomId);
      return room !== null;
    } catch {
      // error-policy:J4 a missing room is equivalent to a cache miss; creation follows.
      return false;
    }
  }

  /**
   * Send a message through the appropriate provider
   */
  async sendMessage(params: SendMessageParams): Promise<boolean> {
    if (!(["twilio", "blooio", "whatsapp"] as const).includes(params.provider)) {
      logger.error("[MessageRouter] Unsupported message provider", {
        organizationId: params.organizationId,
      });
      return false;
    }
    logger.info("[MessageRouter] Sending message", {
      provider: providerDiagnostic(params.provider),
      organizationId: params.organizationId,
    });

    const contactRequired = this.contactWriteRequired(params);

    const delivered =
      params.provider === "twilio"
        ? await this.sendViaTwilio(params)
        : params.provider === "blooio"
          ? await this.sendViaBlooio(params)
          : await this.sendViaWhatsApp(params);
    if (!delivered) return false;
    if (!contactRequired) return true;

    try {
      await this.recordAgentPhoneContact(params);
    } catch (error) {
      // error-policy:J4 provider delivery is authoritative; a failed audit write
      // cannot turn a completed send into a retry that duplicates the message.
      logger.error("[MessageRouter] Contact record failed after delivery", {
        provider: providerDiagnostic(params.provider),
        organizationId: params.organizationId,
        ...phoneErrorDiagnostic(error),
      });
    }
    return true;
  }

  private normalizeContactIdentifier(value: string): string {
    const trimmed = value.trim();
    return trimmed.includes("@") ? trimmed.toLowerCase() : normalizePhoneNumber(trimmed);
  }

  private contactWriteRequired(params: SendMessageParams): boolean {
    return Boolean(
      params.agentId &&
        params.agentOrganizationId &&
        params.agentUserId &&
        this.normalizeContactIdentifier(params.to),
    );
  }

  private async recordAgentPhoneContact(params: SendMessageParams): Promise<void> {
    if (!params.agentId || !params.agentOrganizationId || !params.agentUserId) {
      return;
    }

    const agentId = params.agentId;
    const agentOrganizationId = params.agentOrganizationId;
    const agentUserId = params.agentUserId;
    const contactIdentifier = this.normalizeContactIdentifier(params.to);
    if (!contactIdentifier) {
      return;
    }

    const now = new Date();
    const contactDisplayName = params.contactDisplayName ?? null;
    const contactValues: typeof agentPhoneContacts.$inferInsert = {
      organization_id: agentOrganizationId,
      user_id: agentUserId,
      agent_id: agentId,
      provider: params.provider,
      contact_identifier: contactIdentifier,
      contact_display_name: contactDisplayName,
      first_contacted_at: now,
      last_contacted_at: now,
      last_outbound_at: now,
      is_active: true,
    };
    const upsert = async () =>
      await dbWrite
        .insert(agentPhoneContacts)
        .values(contactValues)
        .onConflictDoUpdate({
          target: [
            agentPhoneContacts.provider,
            agentPhoneContacts.contact_identifier,
            agentPhoneContacts.agent_id,
          ],
          set: {
            organization_id: agentOrganizationId,
            user_id: agentUserId,
            contact_display_name: contactDisplayName,
            last_contacted_at: now,
            last_outbound_at: now,
            is_active: true,
            updated_at: now,
          },
        });

    try {
      await upsert();
    } catch (error) {
      // error-policy:J2 preserve the database failure and classify missing schema.
      if (isUndefinedTableError(error)) {
        // error-policy:J2 missing schema is a deployment failure, never a signal
        // to recreate a legacy table from request-serving code.
        throw new ElizaError("Phone contact schema migration is required", {
          code: "PHONE_SCHEMA_MIGRATION_REQUIRED",
          context: { table: "agent_phone_contacts" },
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Send message via Twilio
   */
  private async sendViaTwilio(params: SendMessageParams): Promise<boolean> {
    try {
      const { secretsService } = await import("../secrets");

      // Use secretsService.get() which looks up by (organizationId, secretName)
      // Note: getDecryptedValue() takes (secretId, organizationId) - different signature
      const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = await import("../../constants/secrets");
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
        logger.error("[MessageRouter] Twilio API error", { status: response.status });
        return false;
      }

      logger.info("[MessageRouter] Twilio message sent successfully");
      return true;
    } catch (error) {
      // error-policy:J4 provider errors become a typed delivery outcome at the caller.
      logger.error("[MessageRouter] Twilio send error", phoneErrorDiagnostic(error));
      return false;
    }
  }

  /**
   * Send message via Blooio (iMessage)
   */
  private async sendViaBlooio(params: SendMessageParams): Promise<boolean> {
    try {
      const { secretsService } = await import("../secrets");
      const { blooioApiRequest } = await import("../../utils/blooio-api");

      // Use secretsService.get() which looks up by (organizationId, secretName)
      const { BLOOIO_API_KEY } = await import("../../constants/secrets");
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
      // error-policy:J4 provider errors become a typed delivery outcome at the caller.
      logger.error("[MessageRouter] Blooio send error", phoneErrorDiagnostic(error));
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
      const { sendWhatsAppMessage } = await import("../../utils/whatsapp-api");
      const { secretsService } = await import("../secrets");
      const { WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID } = await import(
        "../../constants/secrets"
      );

      // Try org-specific credentials first (from secrets service)
      let accessToken = await secretsService.get(params.organizationId, WHATSAPP_ACCESS_TOKEN);
      let phoneNumberId = await secretsService.get(params.organizationId, WHATSAPP_PHONE_NUMBER_ID);

      // Fall back to global config (for eliza-app public bot)
      if (!accessToken || !phoneNumberId) {
        const { elizaAppConfig } = await import("../eliza-app/config");
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
      // error-policy:J4 provider errors become a typed delivery outcome at the caller.
      logger.error("[MessageRouter] WhatsApp send error", {
        organizationId: params.organizationId,
        ...phoneErrorDiagnostic(error),
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
    // Normalize phone numbers to prevent SQL injection via malformed data
    // This ensures only valid E.164 formatted numbers are stored
    const normalizedFrom = normalizePhoneNumber(params.from);
    const normalizedTo = normalizePhoneNumber(params.to);

    try {
      return await phoneMessageLogsRepository.create(
        {
          phone_number_id: params.phoneNumberId,
          direction: params.direction,
          from_number: normalizedFrom,
          to_number: normalizedTo,
          message_body: params.body,
          message_type: params.messageType,
          provider_message_id: params.providerMessageId,
          media_urls: params.mediaUrls,
          metadata: params.metadata,
          status: params.status || "received",
          agent_response: params.agentResponse,
          response_time_ms: params.responseTimeMs?.toString(),
        },
        params.organizationId,
      );
    } catch (cause) {
      // error-policy:J2 preserve the storage/validation/database cause while
      // exposing one stable retry signal to every webhook boundary.
      throw new ElizaError("Canonical phone message persistence failed", {
        code: PHONE_MESSAGE_PERSISTENCE_FAILED_CODE,
        cause,
      });
    }
  }

  /**
   * Update message log with agent response
   */
  async updateMessageLog(
    organizationId: string,
    messageLogId: string,
    response: AgentResponse,
    responseTimeMs: number,
  ): Promise<void> {
    await phoneMessageLogsRepository.updateAgentResponse(
      organizationId,
      messageLogId,
      response.text,
      responseTimeMs,
    );
  }

  /**
   * Mark message as failed
   */
  async markMessageFailed(
    organizationId: string,
    messageLogId: string,
    error: string,
  ): Promise<void> {
    await phoneMessageLogsRepository.markFailed(organizationId, messageLogId, error);
  }

  /** Read one message only after tenant-scoped strict pointer hydration. */
  async getMessageLog(
    organizationId: string,
    messageLogId: string,
  ): Promise<PhoneMessageLog | null> {
    return phoneMessageLogsRepository.findHydratedById(organizationId, messageLogId);
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
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://cloud.eliza.app";
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
      agentId: params.agentId,
      organizationId: params.organizationId,
      provider: providerDiagnostic(params.provider),
    });

    return { id: record.id, webhookUrl };
  }

  /**
   * Get all phone numbers for an organization
   */
  async getPhoneNumbers(organizationId: string) {
    const records = await dbWrite
      .select(agentPhoneNumberLosslessSelection)
      .from(agentPhoneNumbers)
      .where(eq(agentPhoneNumbers.organization_id, organizationId));
    return records.map(hydrateAgentPhoneNumber);
  }

  /**
   * Get phone number by ID
   */
  async getPhoneNumberById(id: string) {
    const [record] = await dbWrite
      .select(agentPhoneNumberLosslessSelection)
      .from(agentPhoneNumbers)
      .where(eq(agentPhoneNumbers.id, id))
      .limit(1);

    return record ? hydrateAgentPhoneNumber(record) : null;
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
