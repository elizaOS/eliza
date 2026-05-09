/**
 * Compatibility shim — the relationships-graph service has been merged into
 * `RelationshipsService` in `@elizaos/core`. This file re-exports the public
 * surface from the new core location so existing barrel exports continue to
 * resolve. New code should import from `@elizaos/core` directly.
 */
export {
  type ClusterMemoriesQuery,
  type ClusterSearchQuery,
  createNativeRelationshipsGraphService,
  getMemoriesForCluster,
  type RelationshipsConversationMessage,
  type RelationshipsConversationSnippet,
  type RelationshipsFactExtractedInformation,
  type RelationshipsFactProvenance,
  type RelationshipsGraphEdge,
  type RelationshipsGraphQuery,
  type RelationshipsGraphService,
  type RelationshipsGraphSnapshot,
  type RelationshipsGraphStats,
  type RelationshipsIdentityEdge,
  type RelationshipsIdentityHandle,
  type RelationshipsIdentitySummary,
  type RelationshipsMergeCandidate,
  type RelationshipsPersonDetail,
  type RelationshipsPersonFact,
  type RelationshipsPersonSummary,
  type RelationshipsProfile,
  type RelationshipsRelevantMemory,
  type RelationshipsServiceLike,
  type RelationshipsUserPersonalityPreference,
  searchMemoriesForCluster,
} from "@elizaos/core";

import type {
  IAgentRuntime,
  RelationshipsGraphService,
  RelationshipsServiceLike,
} from "@elizaos/core";
import { resolveOwnerEntityId } from "../runtime/owner-entity.js";
import { fetchConfiguredOwnerName } from "./owner-name.js";

type RelationshipsFeatureRuntime = IAgentRuntime & {
  enableRelationships?: () => Promise<void>;
  isRelationshipsEnabled?: () => boolean;
};

type RelationshipsServiceWithGraph = RelationshipsServiceLike &
  RelationshipsGraphService & {
    setGraphResolvers?: (resolvers: {
      resolveOwnerEntityId: (runtime: IAgentRuntime) => Promise<string | null>;
      fetchConfiguredOwnerName: () => Promise<string | null>;
    }) => void;
  };

function isRelationshipsServiceWithGraph(
  service: unknown,
): service is RelationshipsServiceWithGraph {
  return typeof service === "object" && service !== null;
}

/**
 * Resolve the merged RelationshipsService and wire its agent-side owner
 * resolvers. Compatibility wrapper for the old factory; prefer
 * `runtime.getService("relationships")` directly.
 */
export async function resolveRelationshipsGraphService(
  runtime: IAgentRuntime,
): Promise<RelationshipsGraphService | null> {
  const runtimeWithFeatures = runtime as RelationshipsFeatureRuntime;
  if (
    typeof runtimeWithFeatures.isRelationshipsEnabled === "function" &&
    !runtimeWithFeatures.isRelationshipsEnabled() &&
    typeof runtimeWithFeatures.enableRelationships === "function"
  ) {
    await runtimeWithFeatures.enableRelationships();
  }

  const service = runtime.getService("relationships");
  if (!service || typeof service !== "object") {
    return null;
  }
  if (!isRelationshipsServiceWithGraph(service)) {
    return null;
  }
  const graphService = service;

  if (typeof graphService.setGraphResolvers === "function") {
    graphService.setGraphResolvers({
      resolveOwnerEntityId: (rt) => resolveOwnerEntityId(rt),
      fetchConfiguredOwnerName: () => fetchConfiguredOwnerName(),
    });
  }

  return graphService;
}
