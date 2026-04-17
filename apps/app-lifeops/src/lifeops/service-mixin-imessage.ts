// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { LifeOpsIMessageConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import {
  detectIMessageBackend,
  listIMessageChats as listIMessageChatsBridge,
  readIMessages as readIMessagesBridge,
  sendIMessage as sendIMessageBridge,
  type IMessageBackend,
  type IMessageBridgeConfig,
  type IMessageChat,
  type IMessageRecord,
  type IMessageSendRequest,
} from "./imessage-bridge.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

function resolveBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): IMessageBridgeConfig {
  const raw = env.ELIZA_IMESSAGE_BACKEND?.trim().toLowerCase();
  const preferredBackend: IMessageBackend | undefined =
    raw === "imsg" || raw === "bluebubbles" || raw === "none" ? raw : undefined;
  return {
    preferredBackend,
    bluebubblesUrl: env.ELIZA_BLUEBUBBLES_URL?.trim() || undefined,
    bluebubblesPassword: env.ELIZA_BLUEBUBBLES_PASSWORD?.trim() || undefined,
  };
}

/** @internal */
export function withIMessage<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsIMessageServiceMixin extends Base {
    async getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
      const config = resolveBridgeConfig();
      const backend = await detectIMessageBackend(config);
      return {
        available: backend !== "none",
        connected: backend !== "none",
        accountHandle: null,
        lastSyncAt: new Date().toISOString(),
        error: backend === "none" ? "no_backend_available" : null,
      };
    }

    async sendIMessage(
      req: IMessageSendRequest,
    ): Promise<{ ok: true; messageId?: string }> {
      return sendIMessageBridge(req, resolveBridgeConfig());
    }

    async readIMessages(opts: {
      chatId?: string;
      since?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      return readIMessagesBridge(opts, resolveBridgeConfig());
    }

    async listIMessageChats(): Promise<IMessageChat[]> {
      return listIMessageChatsBridge(resolveBridgeConfig());
    }
  }

  return LifeOpsIMessageServiceMixin;
}
