import {
  type SubscriptionRouteState as AutonomousSubscriptionRouteState,
  type ElizaConfig,
  handleSubscriptionRoutes as handleAutonomousSubscriptionRoutes,
  type RouteRequestContext,
} from "@elizaos/agent";

export type SubscriptionRouteState = Omit<
  AutonomousSubscriptionRouteState,
  "config"
> & {
  config: ElizaConfig;
};

export interface SubscriptionRouteContext extends RouteRequestContext {
  state: SubscriptionRouteState;
  saveConfig: (config: ElizaConfig) => void;
}

export async function handleSubscriptionRoutes(
  ctx: SubscriptionRouteContext,
): Promise<boolean> {
  return handleAutonomousSubscriptionRoutes({
    ...ctx,
    saveConfig: (config: unknown) => ctx.saveConfig(config as ElizaConfig),
    loadSubscriptionAuth: async () =>
      (await import("@elizaos/agent/auth")) as never,
  } as never);
}
