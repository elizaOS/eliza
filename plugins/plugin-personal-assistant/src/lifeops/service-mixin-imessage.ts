import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared";
import type {
  IMessageChat,
  IMessageRecord,
  IMessageSendRequest,
} from "./domains/imessage-service.js";

export type {
  IMessageChat,
  IMessageDeliveryResult,
  IMessageRecord,
  IMessageSendRequest,
} from "./domains/imessage-service.js";

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
