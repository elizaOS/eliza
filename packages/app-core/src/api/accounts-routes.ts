/**
 * Thin wrapper around the agent's `handleAccountsRoutes` so app-core
 * consumers can compose multi-account CRUD + OAuth-from-UI routes
 * into their own HTTP servers without depending directly on the
 * agent package internals. Mirrors `subscription-routes.ts`.
 */

import {
  type AccountsRouteContext as AgentAccountsRouteContext,
  type ElizaConfig,
  handleAccountsRoutes as handleAgentAccountsRoutes,
  type RouteRequestContext,
} from "@elizaos/agent";

export interface AccountsRouteState {
  config: ElizaConfig;
}

export interface AccountsRouteContext extends RouteRequestContext {
  state: AccountsRouteState;
  saveConfig: (config: ElizaConfig) => void;
}

export async function handleAccountsRoutes(
  ctx: AccountsRouteContext,
): Promise<boolean> {
  const agentCtx: AgentAccountsRouteContext = {
    ...ctx,
    state: { config: ctx.state.config },
    saveConfig: (config) => ctx.saveConfig(config),
  };
  return handleAgentAccountsRoutes(agentCtx);
}
