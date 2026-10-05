import type { Task } from '@elizaos/core';

function ownerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function isAgentOwnedHeartbeat(task: Task, agentId: string): boolean {
  return (
    (task.entityId == null || task.entityId === agentId) &&
    (!task.agentId || task.agentId === agentId) &&
    ['queue', 'repeat', 'heartbeat'].every((tag) => (task.tags ?? []).includes(tag))
  );
}

/** Creator labels describe the source of a trigger, not its owner. */
export function isTriggerTaskOwnedBy(
  task: Task,
  ownerEntityId: string,
  localOwnerEntityId: string,
  agentId?: string
): boolean {
  if (agentId && task.agentId && task.agentId !== agentId) return false;
  const metadata = task.metadata;
  const ownership = metadata?.ownership;
  const metadataOwner = ownerId(
    ownership && typeof ownership === 'object' && !Array.isArray(ownership)
      ? (ownership as Record<string, unknown>).ownerId
      : null
  );
  const metadataEntityOwner = ownerId(metadata?.ownerEntityId);
  if (agentId && isAgentOwnedHeartbeat(task, agentId)) {
    return (
      ownerEntityId === localOwnerEntityId &&
      [metadataOwner, metadataEntityOwner].every(
        (owner) => owner === null || owner === agentId || owner === localOwnerEntityId
      )
    );
  }
  const explicitOwners = [ownerId(task.entityId), metadataOwner, metadataEntityOwner].filter(
    (owner): owner is string => owner !== null
  );

  if (explicitOwners.length > 0) {
    // A conflicting persisted owner is corrupt or foreign; never let a second
    // field or the client-controlled createdBy label override it.
    return explicitOwners.every((owner) => owner === ownerEntityId);
  }
  // Old trigger tasks did not store an owner. They belong only to the
  // authenticated local single-owner surface, not another requester.
  return ownerEntityId === localOwnerEntityId;
}
