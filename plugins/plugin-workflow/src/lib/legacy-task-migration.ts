/**
 * Idempotent migration: legacy `workbench-task` Task records → workflows
 *
 * Walks every Task tagged `workbench-task` for the running agent and, for
 * each task that has not already been converted, deploys a one-node workflow
 * built around `workflows-nodes-base.respondToEvent`. The original task is
 * mutated in place to record `metadata.migratedToWorkflowId` so subsequent
 * boots skip it.
 *
 * Designed to run on every plugin init; per-task try/catch keeps a single
 * failed conversion from aborting the loop. The function never throws.
 */

import { type IAgentRuntime, logger, type Task } from '@elizaos/core';
import type { WorkflowService } from '../services/workflow-service';
import { WORKFLOW_SERVICE_TYPE } from '../services/workflow-service';
import type { WorkflowDefinition } from '../types/index';

const WORKBENCH_TASK_TAG = 'workbench-task';
const RESPOND_TO_EVENT_NODE_TYPE = 'workflows-nodes-base.respondToEvent';

export interface LegacyTaskMigrationSummary {
  migrated: number;
  skipped: number;
  failed: number;
}

function readWorkflowService(runtime: IAgentRuntime): WorkflowService | null {
  const svc = runtime.getService(WORKFLOW_SERVICE_TYPE) as WorkflowService | null;
  return svc ?? null;
}

function buildRespondToEventWorkflow(task: Task): WorkflowDefinition {
  const displayName = task.name?.trim().length ? task.name : 'Workbench Task';
  const instructions = task.description?.trim().length ? task.description : displayName;

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

export async function migrateLegacyWorkbenchTasks(
  runtime: IAgentRuntime
): Promise<LegacyTaskMigrationSummary> {
  const summary: LegacyTaskMigrationSummary = { migrated: 0, skipped: 0, failed: 0 };

  const service = readWorkflowService(runtime);
  if (!service) {
    logger.debug(
      { src: 'plugin:workflow:migration:workbench' },
      'WorkflowService not registered; skipping workbench-task migration'
    );
    return summary;
  }

  let tasks: Task[];
  try {
    tasks = await runtime.getTasks({
      agentIds: [runtime.agentId],
      tags: [WORKBENCH_TASK_TAG],
    });
  } catch (err) {
    logger.warn(
      {
        src: 'plugin:workflow:migration:workbench',
        err: err instanceof Error ? err.message : String(err),
      },
      'Failed to list workbench-tagged tasks; aborting migration'
    );
    return summary;
  }

  for (const task of tasks) {
    if (!task.id) {
      summary.skipped += 1;
      continue;
    }

    const metadata = (task.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.migratedToWorkflowId === 'string') {
      summary.skipped += 1;
      continue;
    }

    try {
      const draft = buildRespondToEventWorkflow(task);
      const deployed = await service.deployWorkflow(draft, runtime.agentId);

      if (!deployed.id) {
        // Deploy returned without a workflow id (typically: missing
        // credentials). Treat as a failure rather than marking the task
        // migrated — we want to retry on a future boot.
        summary.failed += 1;
        logger.warn(
          {
            src: 'plugin:workflow:migration:workbench',
            taskId: task.id,
            taskName: task.name,
          },
          'deployWorkflow returned no id; will retry on next boot'
        );
        continue;
      }

      await runtime.updateTask(task.id, {
        metadata: {
          ...metadata,
          migratedToWorkflowId: deployed.id,
          migratedAt: Date.now(),
        },
      });
      summary.migrated += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(
        {
          src: 'plugin:workflow:migration:workbench',
          taskId: task.id,
          taskName: task.name,
          err: err instanceof Error ? err.message : String(err),
        },
        'Failed to migrate workbench task to workflow'
      );
    }
  }

  return summary;
}
