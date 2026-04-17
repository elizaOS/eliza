// @ts-nocheck — mixin: type safety is enforced on the composed class
import { loadElizaConfig } from "@elizaos/agent/config/config";
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

type JsonRecord = Record<string, unknown>;

function coerceString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coerceRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as JsonRecord;
}

function coerceBackend(value: unknown): IMessageBackend | undefined {
  const raw = coerceString(value)?.toLowerCase();
  return raw === "imsg" || raw === "bluebubbles" || raw === "none"
    ? raw
    : undefined;
}

function readConfiguredConnectors(): {
  bluebubbles: JsonRecord | null;
  imessage: JsonRecord | null;
} {
  try {
    const config = coerceRecord(loadElizaConfig());
    const connectors = coerceRecord(config?.connectors ?? config?.channels);
    return {
      bluebubbles: coerceRecord(connectors?.bluebubbles),
      imessage: coerceRecord(connectors?.imessage),
    };
  } catch {
    return {
      bluebubbles: null,
      imessage: null,
    };
  }
}

export function resolveLifeOpsIMessageBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): IMessageBridgeConfig {
  const { bluebubbles, imessage } = readConfiguredConnectors();
  const preferredBackend =
    coerceBackend(env.ELIZA_IMESSAGE_BACKEND) ??
    coerceBackend(env.IMESSAGE_BACKEND);
  const bluebubblesUrl =
    coerceString(env.ELIZA_BLUEBUBBLES_URL) ??
    coerceString(env.BLUEBUBBLES_SERVER_URL) ??
    coerceString(bluebubbles?.serverUrl);
  const bluebubblesPassword =
    coerceString(env.ELIZA_BLUEBUBBLES_PASSWORD) ??
    coerceString(env.BLUEBUBBLES_PASSWORD) ??
    coerceString(bluebubbles?.password);
  const imsgPath =
    coerceString(env.ELIZA_IMESSAGE_CLI_PATH) ??
    coerceString(env.IMESSAGE_CLI_PATH) ??
    coerceString(imessage?.cliPath);
  const fallbackPreferredBackend =
    bluebubbles?.enabled !== false && bluebubblesUrl && bluebubblesPassword
      ? "bluebubbles"
      : imessage?.enabled !== false && imsgPath
        ? "imsg"
        : undefined;
  return {
    preferredBackend: preferredBackend ?? fallbackPreferredBackend,
    bluebubblesUrl,
    bluebubblesPassword,
    imsgPath:
      imessage?.enabled === false &&
      preferredBackend !== "imsg" &&
      fallbackPreferredBackend !== "imsg"
        ? undefined
        : imsgPath,
  };
}

/** @internal */
export function withIMessage<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsIMessageServiceMixin extends Base {
    async getIMessageConnectorStatus(): Promise<LifeOpsIMessageConnectorStatus> {
      const config = resolveLifeOpsIMessageBridgeConfig();
      const backend = await detectIMessageBackend(config);
      const checkedAt = new Date().toISOString();
      return {
        available: backend !== "none",
        connected: backend !== "none",
        bridgeType: backend,
        accountHandle: null,
        lastSyncAt: null,
        lastCheckedAt: checkedAt,
        error: backend === "none" ? "no_backend_available" : null,
      };
    }

    async sendIMessage(
      req: IMessageSendRequest,
    ): Promise<{ ok: true; messageId?: string }> {
      return sendIMessageBridge(req, resolveLifeOpsIMessageBridgeConfig());
    }

    async readIMessages(opts: {
      chatId?: string;
      since?: string;
      limit?: number;
    }): Promise<IMessageRecord[]> {
      return readIMessagesBridge(opts, resolveLifeOpsIMessageBridgeConfig());
    }

    async listIMessageChats(): Promise<IMessageChat[]> {
      return listIMessageChatsBridge(resolveLifeOpsIMessageBridgeConfig());
    }
  }

  return LifeOpsIMessageServiceMixin;
}
