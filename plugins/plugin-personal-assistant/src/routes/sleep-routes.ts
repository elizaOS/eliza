/**
 * `/api/lifeops/sleep/*` routes (history, regularity, baseline) — adapts the
 * LifeOps route context onto `@elizaos/plugin-health`'s generic sleep-route
 * handler, backing it with `LifeOpsService` so owner sleep reads resolve
 * through the same service spine as the rest of LifeOps.
 */

import {
  createHealthSleepRouteHandler,
  type HealthSleepRouteContext,
} from "@elizaos/plugin-health";
import { LifeOpsService } from "../lifeops/service.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

/**
 * Adapter context bridging the LifeOps route shape onto the health plugin's
 * sleep-route handler. The handler's generic constraint defaults `TResponse`
 * to `unknown`, so the `json`/`error` members must accept an `unknown`
 * response argument; the concrete `ServerResponse` is threaded through from
 * the originating LifeOps context instead of being read off this object.
 */
type SleepRouteContext = HealthSleepRouteContext & {
  state: LifeOpsRouteContext["state"];
};

const handleHealthSleepRoutes =
  createHealthSleepRouteHandler<SleepRouteContext>({
    createService: (ctx: SleepRouteContext): LifeOpsService | null => {
      if (!ctx.state.runtime) {
        ctx.error(ctx.res, "Agent runtime is not available", 503);
        return null;
      }
      return new LifeOpsService(ctx.state.runtime, {
        ownerEntityId: ctx.state.adminEntityId,
      });
    },
  });

export async function handleSleepRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const sleepCtx: SleepRouteContext = {
    method: ctx.method,
    pathname: ctx.pathname,
    url: ctx.url,
    res: ctx.res,
    json: (_res: unknown, data: unknown, status?: number) =>
      ctx.json(ctx.res, data, status),
    error: (_res: unknown, message: string, status?: number) =>
      ctx.error(ctx.res, message, status),
    state: ctx.state,
  };
  return handleHealthSleepRoutes(sleepCtx);
}
