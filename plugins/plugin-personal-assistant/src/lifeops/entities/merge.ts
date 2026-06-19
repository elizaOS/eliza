/**
 * Identity-merge engine for the EntityStore.
 *
 * Canonical home is `@elizaos/shared` (`knowledge-graph/merge.ts`). This
 * module re-exports the pure merge functions so the DB-backed `EntityStore`
 * and the rest of LifeOps keep importing from `./merge.js`.
 */

export {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  decideIdentityOutcome,
  findIdentityMatches,
  foldIdentity,
  type IdentityMatchInput,
  type IdentityObserveOutcome,
  mergeEntities,
  OVERRIDE_CONFIDENCE_DELTA,
} from "@elizaos/shared";
