/**
 * SensitiveRequestDeliveryAdapter for `target === "owner_app_oauth"`: the OAuth
 * sibling of the inline-secret adapter. Delivers `kind: "oauth"` requests as an
 * inline chat message whose `secretRequest.form.kind === "oauth"` envelope is
 * rendered by the UI's `OAuthRequestPanel`. Delivery is gated on the request
 * classifying as `owner_app_private`, and the authorization URL travels only
 * inside the envelope's `form.authorizationUrl` — never in the chat `text` (see
 * the security note on the runtime interface below).
 */
import {
  ChannelType,
  type Content,
  classifySensitiveRequestSource,
  type DeliveryResult,
  type DispatchSensitiveRequest,
  logger,
  type SensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
  type SensitiveRequestOAuthTarget,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";

/**
 * Sibling of {@link ownerAppInlineSensitiveRequestAdapter} that handles
 * `target.kind === "oauth"` sensitive-requests. Emits an inline chat message
 * whose `secretRequest.form.kind === "oauth"` envelope is consumed by the
 * `OAuthRequestPanel` widget in
 * `packages/ui/src/components/chat/MessageContent.tsx`.
 *
 * SECURITY: this adapter NEVER substitutes the authorization URL into the
 * chat content `text` field. The URL only travels inside the envelope's
 * `form.authorizationUrl`, where the widget consumes it to open a popup
 * with `noreferrer` (the widget deliberately omits `noopener` — passing it
 * forces `window.open` to return null and destroys the popup-blocked
 * signal — and instead nulls `popup.opener` itself after opening). The
 * widget also never echoes the URL back into chat. The actual
 * token-handling provider lives elsewhere; this adapter only formats and
 * delivers the consent-link envelope.
 */
interface OwnerAppOAuthRuntime {
  sendMessageToTarget(
    target: TargetInfo,
    content: Content,
  ): Promise<unknown> | unknown;
}

function isOwnerAppOAuthRuntime(value: unknown): value is OwnerAppOAuthRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "sendMessageToTarget" in value &&
    typeof (value as { sendMessageToTarget: unknown }).sendMessageToTarget ===
      "function"
  );
}

function isPolicySensitiveRequest(
  value: DispatchSensitiveRequest,
): value is DispatchSensitiveRequest & SensitiveRequest {
  const record = value as Record<string, unknown>;
  const target = record.target;
  const delivery = record.delivery;
  return (
    typeof record.status === "string" &&
    typeof record.agentId === "string" &&
    target !== null &&
    typeof target === "object" &&
    typeof (target as { kind?: unknown }).kind === "string" &&
    delivery !== null &&
    typeof delivery === "object" &&
    typeof (delivery as { mode?: unknown }).mode === "string"
  );
}

const OWNER_APP_SOURCES = new Set(["app", "in_app", "eliza_app", "owner_app"]);

function looksLikeOwnerAppPrivate(input: {
  channelType?: string;
  source?: string;
}): boolean {
  if (input.channelType !== ChannelType.DM) return false;
  const source = (input.source ?? "").trim().toLowerCase();
  return OWNER_APP_SOURCES.has(source);
}

interface OAuthRequestForm {
  type: "sensitive_request_form";
  kind: "oauth";
  mode: "inline_owner_app";
  /** OAuth widget collects nothing in-chat; `fields` is intentionally empty. */
  fields: [];
  submitLabel: string;
  statusOnly: true;
  provider: string;
  scopes?: string[];
  authorizationUrl: string;
}

interface InlineOAuthRequestEnvelope {
  requestId: string;
  provider: string;
  scopes?: string[];
  label?: string;
  expiresAt: string;
  status: "pending";
  delivery: {
    mode: "inline_owner_app";
    instruction?: string;
    privateRouteRequired: boolean;
    canCollectValueInCurrentChannel: true;
  };
  form: OAuthRequestForm;
}

function isOAuthTarget(
  target: SensitiveRequest["target"],
): target is SensitiveRequestOAuthTarget {
  if (!target || (target as { kind?: unknown }).kind !== "oauth") return false;
  // The tight target carries a string `authorizationUrl` and `provider`.
  // The legacy permissive `SensitiveRequestOauthTarget` shape may not — we
  // narrow defensively rather than trust the union member alone.
  const t = target as Record<string, unknown>;
  return (
    typeof t.authorizationUrl === "string" &&
    t.authorizationUrl.length > 0 &&
    typeof t.provider === "string" &&
    t.provider.length > 0
  );
}

function buildOAuthEnvelope(
  request: SensitiveRequest,
): InlineOAuthRequestEnvelope {
  if (!isOAuthTarget(request.target)) {
    throw new Error(
      `owner-app-oauth adapter received non-oauth or malformed target (kind=${
        (request.target as { kind?: string } | undefined)?.kind ?? "undefined"
      })`,
    );
  }
  const target = request.target;
  const label = target.label ?? target.provider;

  return {
    requestId: request.id,
    provider: target.provider,
    scopes: target.scopes,
    label,
    expiresAt: String(request.expiresAt),
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      instruction: (request.delivery as { instruction?: string } | undefined)
        ?.instruction,
      privateRouteRequired:
        (request.delivery as { privateRouteRequired?: boolean } | undefined)
          ?.privateRouteRequired ?? false,
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "oauth",
      mode: "inline_owner_app",
      fields: [],
      submitLabel: `Connect ${label}`,
      statusOnly: true,
      provider: target.provider,
      scopes: target.scopes,
      authorizationUrl: target.authorizationUrl,
    },
  };
}

function buildOAuthContent(envelope: InlineOAuthRequestEnvelope): Content {
  // SECURITY: the authorization URL is intentionally NOT substituted into
  // `text`. It only lives inside `secretRequest.form.authorizationUrl`,
  // which the widget opens in a popup. Embedding the URL here would defeat
  // the popup boundary by letting any chat-rendering surface (preview cards,
  // log dumps, copy-paste) expose the consent link.
  const label = envelope.label ?? envelope.provider;
  return {
    text: `I need to connect ${label}. Click below to authorize.`,
    source: "owner_app",
    channelType: ChannelType.DM,
    secretRequest: envelope,
  } as Content & { secretRequest: InlineOAuthRequestEnvelope };
}

function resolveTarget(
  request: SensitiveRequest,
  channelId?: string,
): TargetInfo {
  return {
    source: "owner_app",
    channelId,
    roomId: (request.sourceRoomId ?? undefined) as UUID | undefined,
    entityId: (request.ownerEntityId ?? undefined) as UUID | undefined,
  };
}

export const ownerAppOAuthSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  {
    target: "owner_app_oauth",

    supportsChannel(_channelId, runtime) {
      // Channel acceptance is decided at deliver time using the request's
      // classified source — mirroring `owner-app-inline-adapter` exactly so
      // both adapters share the same trust boundary.
      return isOwnerAppOAuthRuntime(runtime);
    },

    async deliver({
      request: rawRequest,
      channelId,
      runtime,
    }): Promise<DeliveryResult> {
      if (!isPolicySensitiveRequest(rawRequest)) {
        return {
          delivered: false,
          target: "owner_app_oauth",
          error: "invalid sensitive request payload",
        };
      }
      const request = rawRequest;

      if (!isOwnerAppOAuthRuntime(runtime)) {
        return {
          delivered: false,
          target: "owner_app_oauth",
          error: "runtime missing sendMessageToTarget",
        };
      }

      if (request.target.kind !== "oauth") {
        return {
          delivered: false,
          target: "owner_app_oauth",
          error: `owner-app-oauth supports kind=oauth only (got ${request.target.kind})`,
        };
      }

      if (!isOAuthTarget(request.target)) {
        return {
          delivered: false,
          target: "owner_app_oauth",
          error:
            "owner-app-oauth requires target.provider and target.authorizationUrl",
        };
      }

      const classified = classifySensitiveRequestSource({
        channelType: request.sourceChannelType ?? undefined,
        source:
          request.delivery.source === "owner_app_private"
            ? "owner_app_private"
            : undefined,
        ownerAppPrivateChat:
          request.delivery.mode === "inline_owner_app" ||
          looksLikeOwnerAppPrivate({
            channelType: request.sourceChannelType ?? undefined,
            source: request.sourcePlatform ?? undefined,
          }),
      });

      if (classified !== "owner_app_private") {
        return {
          delivered: false,
          target: "owner_app_oauth",
          error: "channel not owner-app-private",
        };
      }

      const envelope = buildOAuthEnvelope(request);
      const content = buildOAuthContent(envelope);
      const target = resolveTarget(request, channelId);

      try {
        await runtime.sendMessageToTarget(target, content);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          "[OwnerAppOAuthAdapter] sendMessageToTarget failed",
          message,
        );
        return {
          delivered: false,
          target: "owner_app_oauth",
          error: `dispatch failed: ${message}`,
        };
      }

      return {
        delivered: true,
        target: "owner_app_oauth",
        formRendered: true,
        channelId,
        expiresAt: request.expiresAt,
      };
    },
  };
