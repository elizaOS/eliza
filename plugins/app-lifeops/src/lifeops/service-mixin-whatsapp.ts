// @ts-nocheck — Mixin pattern: each `withFoo()` returns a class that calls
// methods belonging to sibling mixins (e.g. `this.recordScreenTimeEvent`).
// Type checking each mixin in isolation surfaces 700+ phantom errors because
// the local TBase constraint can't see sibling mixin methods. Real type
// safety is enforced at the composed-service level (LifeOpsService class).
// Refactoring requires either declaration-merging every cross-mixin method
// or moving to a single composed interface — tracked as separate work.
import type { LifeOpsWhatsAppConnectorStatus } from "@elizaos/shared/contracts/lifeops";
import { sendWhatsAppMessageWithRuntimeService } from "./runtime-service-delegates.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import { fail } from "./service-normalize.js";
import {
  drainWhatsAppInboundBuffer,
  parseAndBufferWhatsAppWebhookMessages,
  peekWhatsAppInboundBuffer,
  type WhatsAppMessage,
  type WhatsAppSendRequest,
} from "./whatsapp-client.js";

const WHATSAPP_PLUGIN_SETUP_MESSAGE =
  "WhatsApp is managed by @elizaos/plugin-whatsapp. Configure and enable the WhatsApp connector plugin; LifeOps no longer sends with local WhatsApp credentials.";

type WhatsAppRuntimeServiceLike = {
  connected?: boolean;
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
  const service = runtime.getService(
    "whatsapp",
  ) as WhatsAppRuntimeServiceLike | null;
  return service && typeof service === "object" ? service : null;
}

/** @internal */
export function withWhatsApp<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsWhatsAppServiceMixin extends Base {
    async getWhatsAppConnectorStatus(): Promise<LifeOpsWhatsAppConnectorStatus> {
      const runtimeService = getWhatsAppRuntimeService(this.runtime);
      const serviceConnected = Boolean(runtimeService?.connected);
      const outboundReady = Boolean(
        runtimeService?.sendMessage && serviceConnected,
      );
      const inboundReady = Boolean(
        serviceConnected &&
          (runtimeService?.fetchConnectorMessages ||
            runtimeService?.handleWebhook),
      );
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
    pullWhatsAppRecent(limit = 25): {
      count: number;
      messages: WhatsAppMessage[];
    } {
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
