import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared";
import {
  WhatsAppDomain,
  type WhatsAppMessage,
  type WhatsAppSendRequest,
} from "./domains/whatsapp-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
    // re-exported mixin class.
    readonly whatsappDomain = new WhatsAppDomain(this);

    getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      return this.whatsappDomain.getWhatsAppConnectorStatus();
    }

    sendWhatsAppMessage(
      req: WhatsAppSendRequest,
    ): Promise<{ ok: true; messageId: string }> {
      return this.whatsappDomain.sendWhatsAppMessage(req);
    }

    ingestWhatsAppWebhook(
      payload: unknown,
    ): Promise<{ ingested: number; messages: WhatsAppMessage[] }> {
      return this.whatsappDomain.ingestWhatsAppWebhook(payload);
    }

    syncWhatsAppInbound(): Promise<{
      drained: number;
      messages: WhatsAppMessage[];
    }> {
      return this.whatsappDomain.syncWhatsAppInbound();
    }

    pullWhatsAppRecent(limit = 25): Promise<{
      count: number;
      messages: WhatsAppMessage[];
    }> {
      return this.whatsappDomain.pullWhatsAppRecent(limit);
    }
  }

  return LifeOpsWhatsAppServiceMixin;
}

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
