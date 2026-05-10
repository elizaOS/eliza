/**
 * Backward-compat shim for the old `ContactResolver` surface.
 *
 * Existing planner code resolves contacts as `{ name?: string }` →
 * `{ id, name, primaryChannel, primaryHandle, ... }`. The new
 * EntityStore.resolve returns `EntityResolveCandidate[]` with a different
 * shape. This shim adapts one to the other so legacy callers keep
 * compiling until W2-D removes them.
 *
 * NOTE: this file is intentionally minimal. Any caller using more than
 * `name` lookup should migrate to `EntityStore.resolve` directly.
 *
 * DELETION: removed in Wave-2 W2-D.
 */

import type { EntityStore } from "./store.js";

export interface ResolvedContactShim {
  entityId: string;
  name: string;
  primaryChannel?: string;
  primaryHandle?: string;
  confidence: number;
  safeToSend: boolean;
}

export interface ContactResolverShim {
  resolveByName(name: string): Promise<ResolvedContactShim[]>;
}

export function createContactResolverShim(
  store: EntityStore,
): ContactResolverShim {
  return {
    async resolveByName(name) {
      const candidates = await store.resolve({ name, type: "person" });
      return candidates.map((candidate) => {
        const firstIdentity = candidate.entity.identities[0];
        const result: ResolvedContactShim = {
          entityId: candidate.entity.entityId,
          name: candidate.entity.preferredName,
          confidence: candidate.confidence,
          safeToSend: candidate.safeToSend,
          ...(firstIdentity?.platform
            ? { primaryChannel: firstIdentity.platform }
            : {}),
          ...(firstIdentity?.handle
            ? { primaryHandle: firstIdentity.handle }
            : {}),
        };
        return result;
      });
    },
  };
}
