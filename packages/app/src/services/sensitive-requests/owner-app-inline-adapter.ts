import {
  isOwnerAppDeliveryRuntime,
  isPolicySensitiveRequest,
  looksLikeOwnerAppPrivate,
  resolveOwnerAppTarget,
} from "./owner-app-delivery.js";
/**
 * SensitiveRequestDeliveryAdapter for `target === "owner_app_inline"`: delivers
 * `kind: "secret"` sensitive-requests inline into the owner-app private DM chat.
 * It builds a status-only `secretRequest` envelope (rendered by the UI's
 * `SensitiveRequestBlock`) and dispatches it via the runtime's
 * `sendMessageToTarget`. Delivery is gated on the request classifying as
 * `owner_app_private` (`classifySensitiveRequestSource`), so secrets are only
 * collected on the local owner surface. Supports multi-key tunnel requests
 * (sub-agent credential scopes) and per-field image/file upload inputs. The
 * runtime is type-narrowed at the boundary instead of importing `IAgentRuntime`,
 * so the registry can pass `unknown`.
 */

import {
  ChannelType,
  type Content,
  classifySensitiveRequestSource,
  type DeliveryResult,
  logger,
  requireConfirmedSendHandlerDelivery,
  type SensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
  type SensitiveRequestSecretTarget,
} from "@elizaos/core";

/**
 * Runtime surface this adapter requires. We type-narrow at the boundary
 * rather than depending on `IAgentRuntime` directly so the adapter can be
 * unit-tested with a minimal mock and so the registry can pass `unknown`.
 */
interface SensitiveRequestFormField {
  name: string;
  label?: string;
  input: "secret" | "text" | "image" | "file";
  required: boolean;
  /** For `input: "image" | "file"` — accepted MIME types (file input `accept`). */
  mimeTypes?: string[];
  /** For `input: "image" | "file"` — max upload size in bytes. */
  maxBytes?: number;
}

interface SensitiveRequestForm {
  type: "sensitive_request_form";
  kind: "secret";
  mode: "inline_owner_app";
  fields: SensitiveRequestFormField[];
  submitLabel: string;
  statusOnly: true;
}

interface InlineSecretRequestEnvelope {
  requestId: string;
  key: string;
  label?: string;
  reason?: string;
  expiresAt: string;
  status: "pending";
  delivery: {
    mode: "inline_owner_app";
    instruction?: string;
    privateRouteRequired: boolean;
    canCollectValueInCurrentChannel: true;
    tunnel?: {
      credentialScopeId: string;
      childSessionId: string;
      keys?: readonly string[];
    };
  };
  form: SensitiveRequestForm;
}

function buildInlineEnvelope(
  request: SensitiveRequest,
): InlineSecretRequestEnvelope {
  if (request.target.kind !== "secret") {
    throw new Error(
      `owner-app-inline adapter received non-secret request kind: ${request.target.kind}`,
    );
  }
  const target = request.target as SensitiveRequestSecretTarget;
  const tunnel = request.delivery.tunnel;
  const fieldKeys =
    tunnel?.keys && tunnel.keys.length > 0 ? tunnel.keys : [target.key];
  const label = fieldKeys.length === 1 ? fieldKeys[0] : "Sub-agent credentials";

  return {
    requestId: request.id,
    key: target.key,
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
      ...(tunnel
        ? {
            tunnel: {
              credentialScopeId: tunnel.credentialScopeId,
              childSessionId: tunnel.childSessionId,
              ...(tunnel.keys ? { keys: tunnel.keys } : {}),
            },
          }
        : {}),
    },
    form: {
      type: "sensitive_request_form",
      kind: "secret",
      mode: "inline_owner_app",
      // Multi-key tunnel requests are always typed secrets; a single-key secret
      // target may opt into an image/file upload via its `input` descriptor
      // (e.g. photograph a 2FA seed). #8910
      fields: fieldKeys.map((key) => {
        const isTargetKey = key === target.key;
        const input =
          isTargetKey && target.input ? target.input : ("secret" as const);
        const field: SensitiveRequestFormField = {
          name: key,
          label: key,
          input,
          required: true,
        };
        if (input === "image" || input === "file") {
          if (target.mimeTypes && target.mimeTypes.length > 0) {
            field.mimeTypes = target.mimeTypes;
          }
          if (typeof target.maxBytes === "number") {
            field.maxBytes = target.maxBytes;
          }
        }
        return field;
      }),
      submitLabel: "Save secret",
      statusOnly: true,
    },
  };
}

function buildInlineContent(envelope: InlineSecretRequestEnvelope): Content {
  const needs =
    envelope.form.fields.length === 1
      ? envelope.form.fields[0]?.name
      : "these credentials";
  return {
    text: `I need ${needs}. Enter it in this owner-only app form below.`,
    source: "owner_app",
    channelType: ChannelType.DM,
    // `secretRequest` is the canonical content key the UI projector reads to
    // hydrate `ConversationMessage.secretRequest` for `SensitiveRequestBlock`.
    secretRequest: envelope,
  } as Content & { secretRequest: InlineSecretRequestEnvelope };
}

export const ownerAppInlineSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  {
    target: "owner_app_inline",

    supportsChannel(_channelId, runtime) {
      // Channel acceptance is decided at deliver time using the request's
      // classified source — the registry passes `channelId` here only as a
      // hint. The real authority is the policy classifier already used by
      // `request-secret.ts` (`classifySensitiveRequestSource`).
      return isOwnerAppDeliveryRuntime(runtime);
    },

    async deliver({
      request: rawRequest,
      channelId,
      runtime,
    }): Promise<DeliveryResult> {
      if (!isPolicySensitiveRequest(rawRequest)) {
        return {
          delivered: false,
          target: "owner_app_inline",
          error: "invalid sensitive request payload",
        };
      }
      const request = rawRequest;
      if (!isOwnerAppDeliveryRuntime(runtime)) {
        return {
          delivered: false,
          target: "owner_app_inline",
          error: "runtime missing sendMessageToTarget",
        };
      }

      if (request.target.kind !== "secret") {
        return {
          delivered: false,
          target: "owner_app_inline",
          error: `owner-app-inline supports kind=secret only (got ${request.target.kind})`,
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
          target: "owner_app_inline",
          error: "channel not owner-app-private",
        };
      }

      const envelope = buildInlineEnvelope(request);
      const content = buildInlineContent(envelope);
      const target = resolveOwnerAppTarget(request, channelId);

      try {
        requireConfirmedSendHandlerDelivery(
          await runtime.sendMessageToTarget(target, content),
        );
      } catch (error) {
        // error-policy:J1 sensitive-request delivery boundary converts
        // unconfirmed connector outcomes into a typed failed delivery.
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          "[OwnerAppInlineAdapter] sendMessageToTarget failed",
          message,
        );
        return {
          delivered: false,
          target: "owner_app_inline",
          error: `dispatch failed: ${message}`,
        };
      }

      return {
        delivered: true,
        target: "owner_app_inline",
        formRendered: true,
        channelId,
        expiresAt: request.expiresAt,
      };
    },
  };
