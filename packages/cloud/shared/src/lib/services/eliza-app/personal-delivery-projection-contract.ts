/** Defines the internal Durable Object address and fail-closed invalidation contract. */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { getCloudBinding } from "../../runtime/cloud-bindings";

export const PERSONAL_DELIVERY_PROJECTION_BINDING = "PERSONAL_DELIVERY_PROJECTIONS";
export const PERSONAL_DELIVERY_PROJECTION_RESOLVE_PATH = "/resolve";
export const PERSONAL_DELIVERY_PROJECTION_INVALIDATE_PATH = "/invalidate";
export const PERSONAL_DELIVERY_PROJECTION_FENCE_PATH = "/fence";
export const PERSONAL_DELIVERY_PROJECTION_RELEASE_PATH = "/release";

export type PersonalDeliveryProjectionIdentity = {
  platform: "telegram" | "discord" | "phone";
  platformUserId: string;
};

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

async function mutatePersonalDeliveryProjectionFence(
  namespace: RuntimeDurableObjectNamespace,
  identity: PersonalDeliveryProjectionIdentity,
  token: string,
  action: "fence" | "release",
): Promise<void> {
  const path =
    action === "fence"
      ? PERSONAL_DELIVERY_PROJECTION_FENCE_PATH
      : PERSONAL_DELIVERY_PROJECTION_RELEASE_PATH;
  const response = await namespace
    .getByName(personalDeliveryProjectionObjectName(identity.platform, identity.platformUserId))
    .fetch(`https://personal-delivery-projection${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  if (!response.ok) {
    throw new Error(`Personal delivery projection ${action} failed with status ${response.status}`);
  }
}

/**
 * Durably fences every sender object before a canonical lifecycle mutation.
 *
 * A fenced object always resolves from Postgres and never stores a cache entry.
 * The mutation releases its unique token only after the write finishes. If the
 * process dies at any point after fencing, the token remains durable and future
 * turns degrade to canonical resolution instead of using stale authority.
 */
export async function runWithBoundPersonalDeliveryProjectionFences<T>(
  identities: readonly PersonalDeliveryProjectionIdentity[],
  operation: () => Promise<T>,
): Promise<T> {
  const namespace = getCloudBinding<RuntimeDurableObjectNamespace>(
    PERSONAL_DELIVERY_PROJECTION_BINDING,
  );
  if (!namespace) return operation();

  const unique = new Map<string, PersonalDeliveryProjectionIdentity>();
  for (const identity of identities) {
    const platformUserId = identity.platformUserId.trim();
    if (!platformUserId) continue;
    const normalized = { ...identity, platformUserId };
    unique.set(`${normalized.platform}:${normalized.platformUserId}`, normalized);
  }
  const ordered = [...unique.values()].sort((left, right) =>
    personalDeliveryProjectionObjectName(left.platform, left.platformUserId).localeCompare(
      personalDeliveryProjectionObjectName(right.platform, right.platformUserId),
    ),
  );
  if (ordered.length === 0) return operation();

  const token = crypto.randomUUID();
  const acquired: PersonalDeliveryProjectionIdentity[] = [];
  try {
    for (const identity of ordered) {
      await mutatePersonalDeliveryProjectionFence(namespace, identity, token, "fence");
      acquired.push(identity);
    }
  } catch (error) {
    await Promise.allSettled(
      acquired.map((identity) =>
        mutatePersonalDeliveryProjectionFence(namespace, identity, token, "release"),
      ),
    );
    throw error;
  }

  let operationResult: T;
  try {
    operationResult = await operation();
  } catch (error) {
    await Promise.allSettled(
      acquired.map((identity) =>
        mutatePersonalDeliveryProjectionFence(namespace, identity, token, "release"),
      ),
    );
    throw error;
  }

  const releaseResults = await Promise.allSettled(
    acquired.map((identity) =>
      mutatePersonalDeliveryProjectionFence(namespace, identity, token, "release"),
    ),
  );
  const failedRelease = releaseResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failedRelease) throw failedRelease.reason;
  return operationResult;
}
