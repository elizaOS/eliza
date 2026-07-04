/**
 * Type-only public surface the `withRelationships` mixin contributes to
 * `LifeOpsService` — relationship upsert/get/list plus interaction logging. It
 * is declared here and declaration-merged onto `LifeOpsService` because the
 * mixin composition exceeds TypeScript's inference depth.
 */
import type {
  LifeOpsMessageChannel,
  LifeOpsRelationship,
  LifeOpsRelationshipInteraction,
} from "@elizaos/shared";
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
