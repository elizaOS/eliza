import {
  AgentExportError,
  type AgentTransferRouteState,
  type AgentTransferRouteContext as AutonomousAgentTransferRouteContext,
  estimateExportSize,
  exportAgent,
  handleAgentTransferRoutes as handleAutonomousAgentTransferRoutes,
  importAgent,
  type RouteRequestContext,
} from "@elizaos/agent";

export type { AgentTransferRouteState };

export interface AgentTransferRouteContext extends RouteRequestContext {
  state: AgentTransferRouteState;
}

function toAutonomousContext(
  ctx: AgentTransferRouteContext,
): AutonomousAgentTransferRouteContext {
  return {
    ...ctx,
    exportAgent,
    estimateExportSize,
    importAgent,
    isAgentExportError: (error: unknown) => error instanceof AgentExportError,
  };
}

export async function handleAgentTransferRoutes(
  ctx: AgentTransferRouteContext,
): Promise<boolean> {
  return handleAutonomousAgentTransferRoutes(toAutonomousContext(ctx));
}
