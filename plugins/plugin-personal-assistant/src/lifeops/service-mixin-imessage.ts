import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import {
  type IMessageChat,
  type IMessageDeliveryResult,
  IMessageDomain,
  type IMessageRecord,
  type IMessageSendRequest,
} from "./domains/imessage-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

export type {
  IMessageChat,
  IMessageDeliveryResult,
  IMessageRecord,
  IMessageSendRequest,
} from "./domains/imessage-service.js";

/** @internal */
export function withIMessage<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsIMessageServiceMixin extends Base {
    // `this` satisfies LifeOpsContext. Public to avoid TS4094 on the
    // re-exported mixin class.
    readonly imessageDomain = new IMessageDomain(this);

    getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
      return this.imessageDomain.getIMessageConnectorStatus();
    }

    sendIMessage(
      req: IMessageSendRequest,
    ): Promise<{ ok: true; messageId?: string }> {
      return this.imessageDomain.sendIMessage(req);
    }

    readIMessages(opts: {
      chatId?: string;
      since?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      return this.imessageDomain.readIMessages(opts);
    }

    listIMessageChats(): Promise<IMessageChat[]> {
      return this.imessageDomain.listIMessageChats();
    }

    searchIMessages(opts: {
      query: string;
      chatId?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      return this.imessageDomain.searchIMessages(opts);
    }

    getIMessageDeliveryStatus(
      messageIds: string[],
    ): Promise<IMessageDeliveryResult[]> {
      return this.imessageDomain.getIMessageDeliveryStatus(messageIds);
    }
  }

  return LifeOpsIMessageServiceMixin;
}

/** Public surface added by {@link withIMessage}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsIMessageService {
  getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus>;
  sendIMessage(
    req: IMessageSendRequest,
  ): Promise<{ ok: true; messageId?: string }>;
  readIMessages(opts: {
    chatId?: string;
    since?: string;
    limit?: number;
  }): Promise<IMessageRecord[]>;
  listIMessageChats(): Promise<IMessageChat[]>;
}
