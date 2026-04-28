import {
  type RegistryRouteContext as AutonomousRegistryRouteContext,
  classifyRegistryPluginRelease,
  handleRegistryRoutes as handleAutonomousRegistryRoutes,
  type PluginManagerLike,
  type RouteHelpers,
  type RouteRequestMeta,
} from "@elizaos/agent";

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
