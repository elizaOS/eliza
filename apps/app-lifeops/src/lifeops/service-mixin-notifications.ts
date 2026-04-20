// @ts-nocheck — mixin: type safety is enforced on the composed class
import type { LifeOpsConnectorDegradation } from "@elizaos/shared/contracts/lifeops";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";
import {
  readNtfyConfigFromEnv,
  sendPush,
  type SendPushRequest,
  type SendPushResult,
} from "./notifications-push.js";

// ---------------------------------------------------------------------------
// Capability descriptor
// ---------------------------------------------------------------------------

/**
 * Capability descriptor for the notifications (push) connector.
 *
 * inbound:        false  — Ntfy is publish-only; we do not poll for replies.
 * outbound:       true   — publish to any topic via HTTP POST.
 * search:         false  — no message history API.
 * identity:       false  — topic-based, no per-user identity.
 * attachments:    false  — plaintext body only in v1.
 * deliveryStatus: partial — Ntfy returns a message ID on success but does not
 *                           provide read receipts or per-device delivery status.
 */
export const NOTIFICATIONS_CAPABILITIES = {
  inbound: false,
  outbound: true,
  search: false,
  identity: false,
  attachments: false,
  deliveryStatus: "partial",
} as const;

export type NotificationsCapabilities = typeof NOTIFICATIONS_CAPABILITIES;

// ---------------------------------------------------------------------------
// Connector status type
// ---------------------------------------------------------------------------

export interface NotificationsConnectorStatus {
  provider: "notifications";
  connected: boolean;
  baseUrl: string | null;
  defaultTopic: string | null;
  lastCheckedAt: string;
  degradations: LifeOpsConnectorDegradation[];
}

// ---------------------------------------------------------------------------
// Mixin
// ---------------------------------------------------------------------------

/** @internal */
export function withNotifications<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
) {
  class LifeOpsNotificationsServiceMixin extends Base {
    getNotificationsConnectorStatus(): NotificationsConnectorStatus {
      try {
        const config = readNtfyConfigFromEnv();
        return {
          provider: "notifications",
          connected: true,
          baseUrl: config.baseUrl,
          defaultTopic: config.defaultTopic,
          lastCheckedAt: new Date().toISOString(),
          degradations: [],
        };
      } catch {
        return {
          provider: "notifications",
          connected: false,
          baseUrl: null,
          defaultTopic: null,
          lastCheckedAt: new Date().toISOString(),
          degradations: [
            {
              axis: "transport-offline",
              code: "notifications_unconfigured",
              message: "Desktop/mobile push transport is not configured.",
              retryable: false,
            },
          ],
        };
      }
    }

    async sendPushNotification(
      request: SendPushRequest,
    ): Promise<SendPushResult> {
      // readNtfyConfigFromEnv throws NtfyConfigError if unconfigured — surfaces to caller.
      const config = readNtfyConfigFromEnv();
      return sendPush(request, config);
    }
  }

  return LifeOpsNotificationsServiceMixin;
}
