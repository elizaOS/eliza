/**
 * WhatsApp service mixin: declares the LifeOps WhatsApp service surface and the
 * mixin that composes the whatsapp domain's fetch/send methods onto the
 * LifeOpsService base.
 */
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared";
import type {
  WhatsAppMessage,
  WhatsAppSendRequest,
} from "./domains/whatsapp-service.js";

/**
 * Public surface added by {@link withWhatsApp}. Hand-declared (not derived from
 * the mixin instance, which would force full mixin evaluation) and listed on the
 * `LifeOpsService` declaration-merge interface to surface these runtime methods —
 * composition exceeds TypeScript's mixin inference depth.
 */
export interface LifeOpsWhatsAppService {
  getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus>;
  sendWhatsAppMessage(
    req: WhatsAppSendRequest,
  ): Promise<{ ok: true; messageId: string }>;
  pullWhatsAppRecent(
    limit?: number,
  ): Promise<{ count: number; messages: WhatsAppMessage[] }>;
}
