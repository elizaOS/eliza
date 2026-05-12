// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.logLifeOpsWarn`,
// `this.pullWhatsAppRecent`). Type checking each mixin in isolation surfaces
// phantom errors because the local TBase constraint can't see sibling mixin
// methods. Real type safety is enforced at the composed LifeOpsService level.
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared";
import {
  fetchWhatsAppMessagesWithRuntimeService,
  sendWhatsAppMessageWithRuntimeService,
} from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";

const WHATSAPP_PLUGIN_SETUP_MESSAGE =
  "WhatsApp is managed by @elizaos/plugin-whatsapp. Configure and enable the WhatsApp connector plugin; LifeOps no longer sends with local WhatsApp credentials.";

type WhatsAppSendRequest = {
  to: string;
  text: string;
  replyToMessageId?: string;
};

type WhatsAppMessage = {
  id: string;
  from: string;
  channelId: string;
  timestamp: string;
  type: "text" | "image" | "audio" | "document" | "unknown";
  text?: string;
  metadata?: Record<string, unknown>;
};

type WhatsAppRuntimeServiceLike = {
  connected?: boolean;
  isServiceConnected?: () => boolean;
  phoneNumber?: string | null;
  sendMessage?: (message: {
    accountId?: string;
    type: "text";
    to: string;
    content: string;
    replyToMessageId?: string;
  }) => Promise<{ messages?: Array<{ id?: string }> }>;
  fetchConnectorMessages?: unknown;
  handleWebhook?: (event: Record<string, unknown>) => Promise<void>;
};

function getWhatsAppRuntimeService(
  runtime: Constructor<LifeOpsServiceBase>["prototype"]["runtime"],
): WhatsAppRuntimeServiceLike | null {
  const service = runtime.getService?.(
    "whatsapp",
  ) as WhatsAppRuntimeServiceLike | null;
  return service && typeof service === "object" ? service : null;
}

function whatsAppServiceCanSend(
  service: WhatsAppRuntimeServiceLike | null,
): boolean {
  return typeof service?.sendMessage === "function";
}

function whatsAppServiceCanRead(
  service: WhatsAppRuntimeServiceLike | null,
): boolean {
  return (
    typeof service?.fetchConnectorMessages === "function" ||
    typeof service?.handleWebhook === "function"
  );
}

function whatsAppServiceConnected(
  service: WhatsAppRuntimeServiceLike | null,
): boolean {
  return Boolean(
    service?.connected === true ||
      service?.isServiceConnected?.() === true ||
      whatsAppServiceCanSend(service) ||
      whatsAppServiceCanRead(service),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isoFromMemory(memory: Memory): string {
  const createdAt = Number(memory.createdAt);
  return Number.isFinite(createdAt) && createdAt > 0
    ? new Date(createdAt).toISOString()
    : new Date().toISOString();
}

function memoryToWhatsAppMessage(memory: Memory): WhatsAppMessage {
  const metadata = record(memory.metadata);
  const whatsapp = record(metadata.whatsapp);
  const sender = record(metadata.sender);
  const id = stringField(
    whatsapp.messageId ??
      metadata.messageIdFull ??
      metadata.messageId ??
      memory.id,
    cryptoRandomFallback(),
  );
  const channelId = stringField(
    whatsapp.chatId ?? metadata.channelId ?? memory.roomId,
    "unknown",
  );
  const from = stringField(
    whatsapp.from ?? sender.id ?? sender.phone ?? memory.entityId,
    channelId,
  );
  return {
    id,
    from,
    channelId,
    timestamp: isoFromMemory(memory),
    type: stringField(whatsapp.type, "text") as WhatsAppMessage["type"],
    text: stringField(memory.content?.text),
    metadata,
  };
}

function cryptoRandomFallback(): string {
  return `whatsapp:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    async getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      const runtimeService = getWhatsAppRuntimeService(this.runtime);
      const serviceConnected = whatsAppServiceConnected(runtimeService);
      const outboundReady = whatsAppServiceCanSend(runtimeService);
      const inboundReady = whatsAppServiceCanRead(runtimeService);
      const status: LifeOpsWhatsAppConnectorStatus = {
        provider: "whatsapp",
        connected: outboundReady || inboundReady,
        inbound: true,
        ...(runtimeService?.phoneNumber
          ? { phoneNumber: runtimeService.phoneNumber }
          : {}),
        localAuthAvailable: false,
        localAuthRegistered: null,
        serviceConnected,
        outboundReady,
        inboundReady,
        transport: serviceConnected ? "baileys" : "unconfigured",
        lastCheckedAt: new Date().toISOString(),
      };

      const degradations: NonNullable<
        LifeOpsWhatsAppConnectorStatus["degradations"]
      > = [];
      if (!runtimeService) {
        degradations.push({
          axis: "delivery-degraded",
          code: "whatsapp_plugin_unavailable",
          message: WHATSAPP_PLUGIN_SETUP_MESSAGE,
          retryable: true,
        });
      } else if (!serviceConnected) {
        degradations.push({
          axis: "delivery-degraded",
          code: "whatsapp_plugin_disconnected",
          message:
            "The WhatsApp runtime service is registered but not connected. Reconnect the WhatsApp connector in @elizaos/plugin-whatsapp.",
          retryable: true,
        });
      } else {
        if (!outboundReady) {
          degradations.push({
            axis: "delivery-degraded",
            code: "whatsapp_plugin_send_unavailable",
            message:
              "The WhatsApp runtime service is connected, but @elizaos/plugin-whatsapp does not expose a send path.",
            retryable: true,
          });
        }
        if (!inboundReady) {
          degradations.push({
            axis: "transport-offline",
            code: "whatsapp_plugin_inbound_unavailable",
            message:
              "The WhatsApp runtime service is connected, but @elizaos/plugin-whatsapp does not expose webhook or message fetch handling.",
            retryable: true,
          });
        }
      }
      if (degradations.length > 0) {
        status.degradations = degradations;
      }

      return status;
    }

    async sendWhatsAppMessage(
      req: WhatsAppSendRequest,
    ): Promise<{ ok: true; messageId: string }> {
      const delegated = await sendWhatsAppMessageWithRuntimeService({
        runtime: this.runtime,
        request: req,
      });
      if (delegated.status === "handled") {
        return delegated.value;
      }
      if (delegated.error) {
        this.logLifeOpsWarn(
          "runtime_service_delegation_failed",
          delegated.reason,
          {
            provider: "whatsapp",
            operation: "message.send",
            error:
              delegated.error instanceof Error
                ? delegated.error.message
                : String(delegated.error),
          },
        );
      }
      fail(
        503,
        `WhatsApp runtime service send is unavailable: ${delegated.reason} ${WHATSAPP_PLUGIN_SETUP_MESSAGE}`,
      );
    }

    async ingestWhatsAppWebhook(
      payload: unknown,
    ): Promise<{ ingested: number; messages: WhatsAppMessage[] }> {
      const runtimeService = getWhatsAppRuntimeService(this.runtime);
      if (
        runtimeService &&
        typeof runtimeService.handleWebhook === "function" &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload)
      ) {
        await runtimeService.handleWebhook(payload as Record<string, unknown>);
        return { ingested: 0, messages: [] };
      }

      fail(
        503,
        `WhatsApp webhook ingestion is owned by @elizaos/plugin-whatsapp. ${WHATSAPP_PLUGIN_SETUP_MESSAGE}`,
      );
    }

    /**
     * Backward-compatible alias for the plugin-managed recent-message read.
     * WhatsApp webhook parsing and message storage live in plugin-whatsapp.
     */
    async syncWhatsAppInbound(): Promise<{
      drained: number;
      messages: WhatsAppMessage[];
    }> {
      const result = await this.pullWhatsAppRecent(100);
      return { drained: result.count, messages: result.messages };
    }

    /** Return recent WhatsApp messages from plugin-whatsapp. */
    async pullWhatsAppRecent(limit = 25): Promise<{
      count: number;
      messages: WhatsAppMessage[];
    }> {
      const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
      const delegated = await fetchWhatsAppMessagesWithRuntimeService({
        runtime: this.runtime,
        limit: clampedLimit,
      });
      if (delegated.status !== "handled") {
        fail(
          delegated.reason.includes("not registered") ? 409 : 502,
          delegated.error instanceof Error
            ? delegated.error.message
            : `${delegated.reason} ${WHATSAPP_PLUGIN_SETUP_MESSAGE}`,
        );
      }
      const messages = delegated.value.map(memoryToWhatsAppMessage);
      return { count: messages.length, messages };
    }
  }

  return LifeOpsWhatsAppServiceMixin;
}
