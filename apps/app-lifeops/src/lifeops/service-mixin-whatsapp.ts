// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  drainWhatsAppInboundBuffer,
  parseAndBufferWhatsAppWebhookMessages,
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
      const messages = parseWhatsAppWebhookMessages(payload);
      return { ingested: messages.length, messages };
    }
  }

  return LifeOpsWhatsAppServiceMixin;
}
