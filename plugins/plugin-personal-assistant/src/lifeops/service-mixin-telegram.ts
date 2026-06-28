import type {
  LifeOpsConnectorSide,
  LifeOpsTelegramConnectorStatus,
  VerifyLifeOpsTelegramConnectorRequest,
  VerifyLifeOpsTelegramConnectorResponse,
} from "@elizaos/shared";
import {
  TelegramDomain,
  type TelegramMessageSearchResult,
  type TelegramReadReceiptResult,
} from "./domains/telegram-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withTelegram<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsTelegramServiceMixin extends Base {
    // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
    // re-exported mixin class.
    readonly telegramDomain = new TelegramDomain(this);

    getTelegramConnectorStatus(
      requestedSide?: LifeOpsConnectorSide,
    ): Promise<LifeOpsTelegramConnectorStatus> {
      return this.telegramDomain.getTelegramConnectorStatus(requestedSide);
    }

    sendTelegramMessage(request: {
      side?: LifeOpsConnectorSide;
      target: string;
      message: string;
    }): Promise<{ ok: true; messageId: string | null }> {
      return this.telegramDomain.sendTelegramMessage(request);
    }

    verifyTelegramConnector(
      request: VerifyLifeOpsTelegramConnectorRequest,
    ): Promise<VerifyLifeOpsTelegramConnectorResponse> {
      return this.telegramDomain.verifyTelegramConnector(request);
    }

    searchTelegramMessages(request: {
      side?: LifeOpsConnectorSide;
      query: string;
      scope?: string;
      limit?: number;
    }): Promise<TelegramMessageSearchResult[]> {
      return this.telegramDomain.searchTelegramMessages(request);
    }

    getTelegramDeliveryStatus(_request: {
      side?: LifeOpsConnectorSide;
      target: string;
      messageIds: string[];
    }): Promise<TelegramReadReceiptResult[]> {
      return this.telegramDomain.getTelegramDeliveryStatus(_request);
    }
  }

  return LifeOpsTelegramServiceMixin;
}

/** Public surface added by {@link withTelegram}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsTelegramService {
  getTelegramConnectorStatus(
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsTelegramConnectorStatus>;
  sendTelegramMessage(request: {
    side?: LifeOpsConnectorSide;
    target: string;
    message: string;
  }): Promise<{ ok: true; messageId: string | null }>;
  verifyTelegramConnector(
    request: VerifyLifeOpsTelegramConnectorRequest,
  ): Promise<VerifyLifeOpsTelegramConnectorResponse>;
  searchTelegramMessages(request: {
    side?: LifeOpsConnectorSide;
    query: string;
    scope?: string;
    limit?: number;
  }): Promise<TelegramMessageSearchResult[]>;
}
