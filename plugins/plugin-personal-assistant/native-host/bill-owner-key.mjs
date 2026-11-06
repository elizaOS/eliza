/**
 * The `owner_key` of every bill store table. The order is persisted, so it
 * never changes. A host that seeds or reads these tables uses this key.
 */
export const billOwnerKey = (owner) =>
  JSON.stringify([
    owner.agentId,
    owner.actorId,
    owner.connector.source,
    owner.connector.accountId,
  ]);
