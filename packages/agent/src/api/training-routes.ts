import type { AgentRuntime } from "@elizaos/core";
import type { RouteHelpers, RouteRequestContext } from "./route-helpers.js";
import type { TrainingServiceLike } from "./training-service-like.js";

const TRAINING_ROUTES_MODULE: string = "@elizaos/app-training/routes/training";

export type TrainingRouteHelpers = RouteHelpers;

export interface TrainingRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
  trainingService: TrainingServiceLike;
  isLoopbackHost: (host: string) => boolean;
}

type TrainingRoutesModule = {
  handleTrainingRoutes?: (
    ctx: TrainingRouteContext,
  ) => Promise<boolean> | boolean;
};

export async function handleTrainingRoutes(
  ctx: TrainingRouteContext,
): Promise<boolean> {
  if (!ctx.pathname.startsWith("/api/training")) return false;

  try {
    const loaded = (await import(
      /* @vite-ignore */ TRAINING_ROUTES_MODULE
    )) as TrainingRoutesModule;
    if (typeof loaded.handleTrainingRoutes !== "function") {
      ctx.error(ctx.res, "Training app routes are not available", 503);
      return true;
    }
    return await loaded.handleTrainingRoutes(ctx);
  } catch {
    ctx.error(ctx.res, "Training app routes are not available", 503);
    return true;
  }
}
