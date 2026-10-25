/** Shared admission and target policy for owner-only sensitive request delivery. */
import {
  ChannelType,
  type Content,
  type DispatchSensitiveRequest,
  type SendHandlerResult,
  type SensitiveRequest,
  type TargetInfo,
  type UUID,
} from "@elizaos/core";

interface OwnerAppDeliveryRuntime {
  sendMessageToTarget(target: TargetInfo, content: Content): SendHandlerResult;
}

export function isOwnerAppDeliveryRuntime(
  value: unknown,
): value is OwnerAppDeliveryRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "sendMessageToTarget" in value &&
    typeof (value as { sendMessageToTarget: unknown }).sendMessageToTarget ===
      "function"
  );
}

export function isPolicySensitiveRequest(
  value: DispatchSensitiveRequest,
): value is DispatchSensitiveRequest & SensitiveRequest {
  if (value === null || typeof value !== "object") return false;
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

/**
 * The owner-app private chat lives on the local Eliza app surface. The
 * canonical signal mirrors `request-secret.ts`'s `buildSecretRequestEnvironment`:
 * a DM-typed channel whose source identifies the owner app.
 */
const OWNER_APP_SOURCES = new Set(["app", "in_app", "eliza_app", "owner_app"]);

export function looksLikeOwnerAppPrivate(input: {
  channelType?: string;
  source?: string;
}): boolean {
  if (input.channelType !== ChannelType.DM) return false;
  const source =
    typeof input.source === "string" ? input.source.trim().toLowerCase() : "";
  return OWNER_APP_SOURCES.has(source);
}

export function resolveOwnerAppTarget(
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
