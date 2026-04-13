import type { RouteHelpers, RouteRequestMeta } from "@elizaos/agent/api";
import {
  type RegistryRouteContext as AutonomousRegistryRouteContext,
  handleRegistryRoutes as handleAutonomousRegistryRoutes,
} from "@elizaos/agent/api/registry-routes";
import { classifyRegistryPluginRelease } from "@elizaos/agent/runtime";
import type { PluginManagerLike } from "@elizaos/agent/services/plugin-manager-types";

export interface RegistryRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  url: URL;
  getPluginManager: () => PluginManagerLike;
  getLoadedPluginNames: () => string[];
  getBundledPluginIds: () => Set<string>;
}

function toAutonomousContext(
  ctx: RegistryRouteContext,
): AutonomousRegistryRouteContext {
  return {
    ...ctx,
    getPluginManager: () => ctx.getPluginManager() as never,
    classifyRegistryPluginRelease,
  };
}

export async function handleRegistryRoutes(
  ctx: RegistryRouteContext,
): Promise<boolean> {
  return handleAutonomousRegistryRoutes(toAutonomousContext(ctx));
}
