/** Defines opaque sender-object addressing and best-effort projection eviction. */

import { v5 as uuidv5 } from "uuid";
import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { getCloudBinding } from "../../runtime/cloud-bindings";

export const PERSONAL_DELIVERY_PROJECTION_BINDING = "PERSONAL_DELIVERY_PROJECTIONS";
export const PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH = "/resolve";
export const PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH = "/invalidate";
const PERSONAL_DELIVERY_PROJECTION_NAMESPACE = "ac9c0746-953a-4995-a96e-17453053ff97";

export function personalDeliveryProjectionObjectName(
  platform: "telegram" | "discord",
  platformUserId: string,
): string {
  return `sender:${uuidv5(
    `${platform}:${platformUserId.trim()}`,
    PERSONAL_DELIVERY_PROJECTION_NAMESPACE,
  )}`;
}

export async function invalidatePersonalDeliveryProjection(
  namespace: RuntimeDurableObjectNamespace | undefined,
  platform: "telegram" | "discord",
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
  platform: "telegram" | "discord",
  platformUserId: string | null | undefined,
): Promise<void> {
  return invalidatePersonalDeliveryProjection(
    getCloudBinding<RuntimeDurableObjectNamespace>(PERSONAL_DELIVERY_PROJECTION_BINDING),
    platform,
    platformUserId,
  );
}
