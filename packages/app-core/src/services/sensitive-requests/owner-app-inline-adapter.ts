import {
  ChannelType,
  type Content,
  classifySensitiveRequestSource,
  type DeliveryResult,
  type DispatchSensitiveRequest,
  logger,
  type SensitiveRequest,
  type SensitiveRequestDeliveryAdapter,
  type SensitiveRequestSecretTarget,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";

/**
 * Runtime surface this adapter requires. We type-narrow at the boundary
 * rather than depending on `IAgentRuntime` directly so the adapter can be
 * unit-tested with a minimal mock and so the registry can pass `unknown`.
 */
interface OwnerAppInlineRuntime {
  sendMessageToTarget(
    target: TargetInfo,
    content: Content,
  ): Promise<unknown> | unknown;
  getRoom?(roomId: string): Promise<{
    channelId?: string;
    serverId?: string;
    type?: string;
    source?: string;
  } | null>;
}

function isOwnerAppInlineRuntime(
  value: unknown,
): value is OwnerAppInlineRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "sendMessageToTarget" in value &&
    typeof (value as { sendMessageToTarget: unknown }).sendMessageToTarget ===
      "function"
  );
}

/**
 * The owner-app private chat lives on the local Eliza app surface. The
 * canonical signal mirrors `request-secret.ts`'s `buildSecretRequestEnvironment`:
 * a DM-typed channel whose source identifies the owner app.
 */
const OWNER_APP_SOURCES = new Set(["app", "in_app", "eliza_app", "owner_app"]);

function looksLikeOwnerAppPrivate(input: {
  channelType?: string;
  source?: string;
}): boolean {
  if (input.channelType !== ChannelType.DM) return false;
  const source = (input.source ?? "").trim().toLowerCase();
  return OWNER_APP_SOURCES.has(source);
}

interface SensitiveRequestFormField {
  name: string;
  label?: string;
  input: "secret" | "text";
  required: boolean;
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
  };
  form: SensitiveRequestForm;
}

function buildInlineEnvelope(
  request: SensitiveRequest,
): InlineSecretRequestEnvelope {
  if (!request.target || request.target.kind !== "secret") {
    throw new Error(
      `owner-app-inline adapter received non-secret request kind: ${request.target?.kind ?? "unknown"}`,
    );
  }
  const target = request.target as SensitiveRequestSecretTarget;
  const label = target.key;

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
        (
          request.delivery as
            | { privateRouteRequired?: boolean }
            | undefined
        )?.privateRouteRequired ?? false,
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "secret",
      mode: "inline_owner_app",
      fields: [
        {
          name: target.key,
          label,
          input: "secret",
          required: true,
        },
      ],
      submitLabel: "Save secret",
      statusOnly: true,
    },
  };
}

function buildInlineContent(envelope: InlineSecretRequestEnvelope): Content {
  return {
    text: `I need ${envelope.key}. Enter it in this owner-only app form below.`,
    source: "owner_app",
    channelType: ChannelType.DM,
    // `secretRequest` is the canonical content key the UI projector reads to
    // hydrate `ConversationMessage.secretRequest` for `SensitiveRequestBlock`.
    secretRequest: envelope,
  } as Content & { secretRequest: InlineSecretRequestEnvelope };
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

export const ownerAppInlineSensitiveRequestAdapter: SensitiveRequestDeliveryAdapter =
  {
    target: "owner_app_inline",

    supportsChannel(_channelId, runtime) {
      // Channel acceptance is decided at deliver time using the request's
      // classified source — the registry passes `channelId` here only as a
      // hint. The real authority is the policy classifier already used by
      // `request-secret.ts` (`classifySensitiveRequestSource`).
      return isOwnerAppInlineRuntime(runtime);
    },

    async deliver({
      request: rawRequest,
      channelId,
      runtime,
    }): Promise<DeliveryResult> {
      // Adapter contract takes the loose dispatch shape; this adapter
      // requires the policy SensitiveRequest internally.
      const request = rawRequest as unknown as SensitiveRequest;
      if (!isOwnerAppInlineRuntime(runtime)) {
        return {
          delivered: false,
          target: "owner_app_inline",
          error: "runtime missing sendMessageToTarget",
        };
      }

      if (request.target?.kind !== "secret") {
        return {
          delivered: false,
          target: "owner_app_inline",
          error: `owner-app-inline supports kind=secret only (got ${request.target?.kind ?? "unknown"})`,
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
      const target = resolveTarget(request, channelId);

      try {
        await runtime.sendMessageToTarget(target, content);
      } catch (error) {
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
