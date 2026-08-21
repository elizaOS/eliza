/** Defines the internal Durable Object address and fail-closed invalidation contract. */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { getCloudBinding } from "../../runtime/cloud-bindings";

export const PERSONAL_DELIVERY_PROJECTION_BINDING = "PERSONAL_DELIVERY_PROJECTIONS";
export const PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH = "/resolve";
export const PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH = "/invalidate";

export function personalDeliveryProjectionObjectName(
  platform: "telegram" | "discord" | "phone",
  platformUserId: string,
): string {
  return `${platform}:${platformUserId.trim()}`;
}

export async function invalidatePersonalDeliveryProjection(
  namespace: RuntimeDurableObjectNamespace | undefined,
  platform: "telegram" | "discord" | "phone",
  platformUserId: string | null | undefined,
): Promise<void> {
  if (!namespace || !platformUserId) return;
  const response = await namespace
    .getByName(personalDeliveryProjectionObjectName(platform, platformUserId))
    .fetch(`https://personal-delivery-projection${PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH}`, {
      method: "POST",
    });
  if (!response.ok) {
    throw new Error(
      `Personal delivery projection invalidation failed with status ${response.status}`,
    );
  }
}

export async function invalidateBoundPersonalDeliveryProjection(
  platform: "telegram" | "discord" | "phone",
  platformUserId: string | null | undefined,
): Promise<void> {
  return invalidatePersonalDeliveryProjection(
    getCloudBinding<RuntimeDurableObjectNamespace>(PERSONAL_DELIVERY_PROJECTION_BINDING),
    platform,
    platformUserId,
  );
}
