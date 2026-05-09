/**
 * Idempotent migration: legacy `kind: "text"` trigger Tasks → workflow triggers
 *
 * Walks every TRIGGER_DISPATCH task for the running agent. For each task whose
 * stored `metadata.trigger.kind` is `"text"` (or omitted, which is the legacy
 * default), deploy a one-node workflow built around
 * `workflows-nodes-base.respondToEvent` and rewrite the trigger metadata so
 * `kind = "workflow"` plus a pointer to the new workflow. A `migratedFromText`
 * marker prevents double-conversion on subsequent boots.
 *
 * Plugin-workflow cannot import @elizaos/agent (would create a cycle), so the
 * minimal trigger shape it reads is inlined here as `LegacyTriggerConfig`.
 */

import { type IAgentRuntime, logger, type Task, type TaskMetadata } from '@elizaos/core';
import type { WorkflowService } from '../services/workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../services/workflow-service';
import type { WorkflowDefinition } from '../types/index';

const TRIGGER_TASK_NAME = 'TRIGGER_DISPATCH';
const RESPOND_TO_EVENT_NODE_TYPE = 'workflows-nodes-base.respondToEvent';

export interface LegacyTextTriggerMigrationSummary {
  migrated: number;
  skipped: number;
  failed: number;
}

/**
 * Subset of @elizaos/core `TriggerConfig` we read here. Inlined to avoid a
 * dependency edge from plugin-workflow into @elizaos/agent. We only touch
 * fields relevant to the text → workflow rewrite.
 */
interface LegacyTriggerConfig {
  triggerId?: string;
  kind?: 'text' | 'workflow';
  instructions?: string;
  displayName?: string;
  triggerType?: string;
  workflowId?: string;
  workflowName?: string;
  [key: string]: unknown;
}

function readWorkflowService(runtime: IAgentRuntime): WorkflowService | null {
  const svc = runtime.getService(WORKFLOW_SERVICE_TYPE) as WorkflowService | null;
  return svc ?? null;
}

function readTriggerFromMetadata(task: Task): LegacyTriggerConfig | null {
  const trigger = (task.metadata as { trigger?: unknown } | undefined)?.trigger;
  if (!trigger || typeof trigger !== 'object' || Array.isArray(trigger)) return null;
  const cfg = trigger as LegacyTriggerConfig;
  if (typeof cfg.triggerId !== 'string') return null;
  return cfg;
}

function buildRespondToEventWorkflow(
  trigger: LegacyTriggerConfig,
  fallbackName: string
): WorkflowDefinition {
  const displayName =
    typeof trigger.displayName === 'string' && trigger.displayName.trim().length > 0
      ? trigger.displayName
      : fallbackName;
  const instructions =
    typeof trigger.instructions === 'string' && trigger.instructions.trim().length > 0
      ? trigger.instructions
      : displayName;

  return {
    name: displayName,
    nodes: [
      {
        id: 'respond-to-event',
        name: 'Respond To Event',
        type: RESPOND_TO_EVENT_NODE_TYPE,
        typeVersion: 1,
        position: [0, 0],
        parameters: {
          instructions,
          displayName,
          wakeMode: 'inject_now',
        },
      },
    ],
    connections: {},
  };
}

export async function migrateLegacyTextTriggers(
  runtime: IAgentRuntime
): Promise<LegacyTextTriggerMigrationSummary> {
  const summary: LegacyTextTriggerMigrationSummary = { migrated: 0, skipped: 0, failed: 0 };

  const service = readWorkflowService(runtime);
  if (!service) {
    logger.debug(
      { src: 'plugin:workflow:migration:text-trigger' },
      'WorkflowService not registered; skipping text-trigger migration'
    );
    return summary;
  }

  let tasks: Task[];
  try {
    tasks = await runtime.getTasksByName(TRIGGER_TASK_NAME);
  } catch (err) {
    logger.warn(
      {
        src: 'plugin:workflow:migration:text-trigger',
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to list trigger dispatch tasks; aborting migration'
    );
    return summary;
  }

  for (const task of tasks) {
    if (!task.id || task.agentId !== runtime.agentId) {
      summary.skipped += 1;
      continue;
    }

    const metadata = (task.metadata ?? {}) as Record<string, unknown>;
    if (metadata.migratedFromText === true) {
      summary.skipped += 1;
      continue;
    }

    const trigger = readTriggerFromMetadata(task);
    if (!trigger) {
      summary.skipped += 1;
      continue;
    }

    // `kind` is optional in the legacy schema; absence implies "text".
    const isTextKind = trigger.kind === 'text' || trigger.kind === undefined;
    if (!isTextKind) {
      summary.skipped += 1;
      continue;
    }

    try {
      const draft = buildRespondToEventWorkflow(trigger, task.name ?? 'Trigger');
      const deployed = await service.deployWorkflow(draft, runtime.agentId);

      if (!deployed.id) {
        summary.failed += 1;
        logger.warn(
          {
            src: 'plugin:workflow:migration:text-trigger',
            taskId: task.id,
            triggerId: trigger.triggerId,
          },
          'deployWorkflow returned no id; will retry on next boot'
        );
        continue;
      }

      const updatedTrigger: LegacyTriggerConfig = {
        ...trigger,
        kind: 'workflow',
        workflowId: deployed.id,
        workflowName: deployed.name,
      };

      // Cast through unknown: the runtime's TaskMetadata.trigger field is
      // typed as the full TriggerConfig, but we read/write a structural
      // subset here (plugin-workflow cannot import @elizaos/agent without
      // cycling). Persistence preserves whatever extra fields we never
      // touch, so the round-trip stays loss-free.
      const nextMetadata = {
        ...metadata,
        trigger: updatedTrigger,
        migratedFromText: true,
        migratedAt: Date.now(),
      } as unknown as TaskMetadata;

      await runtime.updateTask(task.id, { metadata: nextMetadata });
      summary.migrated += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(
        {
          src: 'plugin:workflow:migration:text-trigger',
          taskId: task.id,
          triggerId: trigger.triggerId,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to migrate text trigger to workflow trigger'
      );
    }
  }

  return summary;
}
