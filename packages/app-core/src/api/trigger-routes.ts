import {
  type TriggerRouteContext as AutonomousTriggerRouteContext,
  buildTriggerConfig,
  buildTriggerMetadata,
  DISABLED_TRIGGER_INTERVAL_MS,
  executeTriggerTask,
  getTriggerHealthSnapshot,
  getTriggerLimit,
  handleTriggerRoutes as handleAutonomousTriggerRoutes,
  listTriggerTasks,
  normalizeTriggerDraft,
  type RouteHelpers,
  type RouteRequestContext,
  readTriggerConfig,
  readTriggerRuns,
  TRIGGER_TASK_NAME,
  TRIGGER_TASK_TAGS,
  taskToTriggerSummary,
  triggersFeatureEnabled,
} from "@elizaos/agent";
import type { AgentRuntime } from "@elizaos/core";

export type TriggerRouteHelpers = RouteHelpers;

export interface TriggerRouteContext extends RouteRequestContext {
  runtime: AgentRuntime | null;
}

function toAutonomousContext(
  ctx: TriggerRouteContext,
): AutonomousTriggerRouteContext {
  return {
    ...ctx,
    executeTriggerTask,
    getTriggerHealthSnapshot,
    getTriggerLimit,
    listTriggerTasks,
    readTriggerConfig,
    readTriggerRuns,
    taskToTriggerSummary,
    triggersFeatureEnabled,
    buildTriggerConfig,
    buildTriggerMetadata,
    normalizeTriggerDraft,
    DISABLED_TRIGGER_INTERVAL_MS,
    TRIGGER_TASK_NAME,
    TRIGGER_TASK_TAGS: [...TRIGGER_TASK_TAGS],
  };
}

export async function handleTriggerRoutes(
  ctx: TriggerRouteContext,
): Promise<boolean> {
  return handleAutonomousTriggerRoutes(toAutonomousContext(ctx));
}
