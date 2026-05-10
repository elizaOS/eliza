/**
 * Agent-side wiring for the merged relationships graph in `@elizaos/core`.
 * Import graph types and helpers from `@elizaos/core` directly.
 */

import type {
  IAgentRuntime,
  RelationshipsGraphService,
  RelationshipsServiceLike,
} from "@elizaos/core";
import { resolveOwnerEntityId } from "../runtime/owner-entity.ts";
import { fetchConfiguredOwnerName } from "./owner-name.ts";

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
