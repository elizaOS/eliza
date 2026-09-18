import { getCloudAuthService } from "./cloud-auth-service.ts";
/**
 * Agent-side wiring for the merged relationships graph in `@elizaos/core`.
 * Import graph types and helpers from `@elizaos/core` directly.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  RelationshipsGraphService,
  RelationshipsServiceLike,
} from "@elizaos/plugin-assistant";
import { resolveOwnerEntityId } from "../runtime/owner-entity.ts";
import { fetchConfiguredOwnerName } from "./owner-name.ts";

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
} from "@elizaos/plugin-assistant";

type RelationshipsFeatureRuntime = IAgentRuntime & {
  enableRelationships?: () => Promise<void>;
  isRelationshipsEnabled?: () => boolean;
};

type RelationshipsServiceWithGraph = RelationshipsServiceLike &
  RelationshipsGraphService & {
    setGraphResolvers?: (resolvers: {
      resolveOwnerEntityId: (runtime: IAgentRuntime) => Promise<string | null>;
      fetchConfiguredOwnerName: () => Promise<string | null>;
      resolveOwnerExternalIdentity: (
        runtime: IAgentRuntime,
      ) => Promise<{ source: string; userId: string } | null>;
    }) => void;
  };

/** Methods the {@link RelationshipsGraphService} return type promises to callers. */
const REQUIRED_GRAPH_METHODS = [
  "getGraphSnapshot",
  "getPersonDetail",
  "getCandidateMerges",
  "acceptMerge",
  "rejectMerge",
  "proposeMerge",
] as const satisfies readonly (keyof RelationshipsGraphService)[];

function isRelationshipsServiceWithGraph(
  service: unknown,
): service is RelationshipsServiceWithGraph {
  if (typeof service !== "object" || service === null) {
    return false;
  }
  const candidate = service as Record<string, unknown>;
  return REQUIRED_GRAPH_METHODS.every(
    (method) => typeof candidate[method] === "function",
  );
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
  if (!isRelationshipsServiceWithGraph(service)) {
    return null;
  }
  const graphService = service;

  if (typeof graphService.setGraphResolvers === "function") {
    graphService.setGraphResolvers({
      resolveOwnerEntityId: (rt) => resolveOwnerEntityId(rt),
      fetchConfiguredOwnerName: () => fetchConfiguredOwnerName(),
      resolveOwnerExternalIdentity: async (rt) => {
        const userId = getCloudAuthService(rt)?.getUserId()?.trim();
        return userId ? { source: "elizacloud", userId } : null;
      },
    });
  }

  return graphService;
}
