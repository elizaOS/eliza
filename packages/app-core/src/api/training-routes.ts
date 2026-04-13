import type { AgentRuntime } from "@elizaos/core";
import { isLoopbackHost } from "@elizaos/agent/security/network-policy";
import type {
  RouteHelpers,
  RouteRequestContext,
} from "@elizaos/agent/api/route-helpers";
import { handleTrainingRoutes as handleAutonomousTrainingRoutes } from "@elizaos/agent/api/training-routes";
import type { TrainingServiceLike } from "@elizaos/agent/api/training-service-like";

export type TrainingRouteHelpers = RouteHelpers;

export interface TrainingRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  trainingService: TrainingServiceLike;
}

export async function handleTrainingRoutes(
  ctx: TrainingRouteContext,
): Promise<boolean> {
  return handleAutonomousTrainingRoutes({
    ...ctx,
    isLoopbackHost,
  });
}
