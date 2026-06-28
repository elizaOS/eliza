import type {
  LifeOpsMessageChannel,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
} from "@elizaos/shared";
import { RelationshipsDomain } from "./domains/relationships-service.js";
import type { Constructor, LifeOpsServiceBase } from "./service-mixin-core.js";

/** @internal */
export function withRelationships<
  TBase extends Constructor<LifeOpsServiceBase>,
>(Base: TBase) {
  class LifeOpsRelationshipsServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly relationshipsDomain = new RelationshipsDomain(this);

    upsertRelationship(
      input: Omit<
        LifeOpsRelationship,
        "id" | "agentId" | "createdAt" | "updatedAt"
      > & { id?: string },
    ): Promise<LifeOpsRelationship> {
      return this.relationshipsDomain.upsertRelationship(input);
    }

    getRelationship(id: string): Promise<LifeOpsRelationship | null> {
      return this.relationshipsDomain.getRelationship(id);
    }

    listRelationships(opts?: {
      limit?: number;
      primaryChannel?: LifeOpsMessageChannel;
    }): Promise<LifeOpsRelationship[]> {
      return this.relationshipsDomain.listRelationships(opts);
    }

    logInteraction(
      input: Omit<
        LifeOpsRelationshipInteraction,
        "id" | "agentId" | "createdAt"
      >,
    ): Promise<LifeOpsRelationshipInteraction> {
      return this.relationshipsDomain.logInteraction(input);
    }

    getDaysSinceContact(relationshipId: string): Promise<number | null> {
      return this.relationshipsDomain.getDaysSinceContact(relationshipId);
    }
  }

  return LifeOpsRelationshipsServiceMixin;
}

/** Public surface added by {@link withRelationships}; listed on the LifeOpsService
 * declaration-merge (mixin composition exceeds TS inference depth). Type-only. */
export interface LifeOpsRelationshipService {
  upsertRelationship(
    input: Omit<
      LifeOpsRelationship,
      "id" | "agentId" | "createdAt" | "updatedAt"
    > & { id?: string },
  ): Promise<LifeOpsRelationship>;
  getRelationship(id: string): Promise<LifeOpsRelationship | null>;
  listRelationships(opts?: {
    limit?: number;
    primaryChannel?: LifeOpsMessageChannel;
  }): Promise<LifeOpsRelationship[]>;
  logInteraction(
    input: Omit<LifeOpsRelationshipInteraction, "id" | "agentId" | "createdAt">,
  ): Promise<LifeOpsRelationshipInteraction>;
}
