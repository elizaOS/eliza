import {
  handleTrainingRoutes as handleAutonomousTrainingRoutes,
  isLoopbackHost,
  type RouteHelpers,
  type RouteRequestContext,
  type TrainingServiceLike,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";

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
