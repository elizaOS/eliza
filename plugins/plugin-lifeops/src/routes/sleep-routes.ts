import { createHealthSleepRouteHandler } from "@elizaos/plugin-health";
import { LifeOpsService } from "../lifeops/service.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const handleHealthSleepRoutes = createHealthSleepRouteHandler({
  createService: (ctx: LifeOpsRouteContext): LifeOpsService | null => {
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
  return handleHealthSleepRoutes(ctx);
}
