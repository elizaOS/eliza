// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  drainWhatsAppInboundBuffer,
  parseAndBufferWhatsAppWebhookMessages,
  peekWhatsAppInboundBuffer,
  readWhatsAppCredentialsFromEnv,
  sendWhatsAppMessage as sendWhatsAppMessageRequest,
  WhatsAppError,
  type WhatsAppMessage,
  type WhatsAppSendRequest,
} from "./whatsapp-client.js";

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    async getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      const creds = readWhatsAppCredentialsFromEnv();
      return {
        provider: "whatsapp",
        connected: creds !== null,
        inbound: true,
        ...(creds?.phoneNumberId ? { phoneNumberId: creds.phoneNumberId } : {}),
        lastCheckedAt: new Date().toISOString(),
      };
    }

    async sendWhatsAppMessage(
      req: WhatsAppSendRequest,
    ): Promise<{ ok: true; messageId: string }> {
      const creds = readWhatsAppCredentialsFromEnv();
      if (!creds) {
        fail(
          400,
          "WhatsApp is not configured. Set ELIZA_WHATSAPP_ACCESS_TOKEN and ELIZA_WHATSAPP_PHONE_NUMBER_ID.",
        );
      }
      try {
        return await sendWhatsAppMessageRequest(creds, req);
      } catch (error) {
        if (error instanceof WhatsAppError) {
          fail(
            error.status >= 400 && error.status < 600 ? error.status : 502,
            error.message,
          );
        }
        throw error;
      }
    }

    async ingestWhatsAppWebhook(
      payload: unknown,
    ): Promise<{ ingested: number; messages: WhatsAppMessage[] }> {
      // Buffer messages for periodic drain via syncWhatsAppInbound.
      const messages = parseAndBufferWhatsAppWebhookMessages(payload);
      return { ingested: messages.length, messages };
    }

    /**
     * Drain buffered inbound WhatsApp messages.
     *
     * WhatsApp Business Cloud API has no "list messages" endpoint — all inbound
     * messages arrive via webhook push. This method drains the in-process buffer
     * that {@link ingestWhatsAppWebhook} populates, giving callers periodic-pull
     * semantics on top of the push-only transport.
     *
     * Deduplication is performed by message ID inside the buffer, so calling
     * this method multiple times within one webhook cycle will not double-ingest.
     *
     * Returns the drained messages. Callers are responsible for writing them to
     * memory or any downstream store.
     */
    syncWhatsAppInbound(): { drained: number; messages: WhatsAppMessage[] } {
      const messages = drainWhatsAppInboundBuffer();
      return { drained: messages.length, messages };
    }

    /**
     * Return the current set of buffered inbound WhatsApp messages without
     * clearing the buffer (peek semantics).
     *
     * Use this for periodic inspection — e.g. to surface recent messages to
     * the agent without consuming them from the buffer.  Messages are
     * deduplicated by ID inside the buffer, so repeated calls return the
     * same set until the buffer is drained by {@link syncWhatsAppInbound}.
     *
     * Mirrors the webhook-parser shape: every returned message has the same
     * {@link WhatsAppMessage} structure as those produced by
     * {@link ingestWhatsAppWebhook}.
     *
     * @param limit Maximum number of messages to return (newest first). Default: 25.
     */
    pullWhatsAppRecent(limit = 25): { count: number; messages: WhatsAppMessage[] } {
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
      const all = peekWhatsAppInboundBuffer();
      // Buffer is insertion-ordered (Map preserves insertion order); return
      // the most recently inserted messages by taking from the tail.
      const recent = all.slice(-clampedLimit);
      return { count: recent.length, messages: recent };
    }
  }

  return LifeOpsWhatsAppServiceMixin;
}
