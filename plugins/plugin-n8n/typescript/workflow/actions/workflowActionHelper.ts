import {
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { N8N_WORKFLOW_SERVICE_TYPE, type N8nWorkflowService } from "../services/index";
import type { N8nWorkflowResponse } from "../types/index";
import { buildConversationContext } from "../utils/context";
import { matchWorkflow } from "../utils/generation";

/**
 * Shared helper for workflow lifecycle actions (activate, deactivate, delete, getExecutions).
 *
 * Handles the common pattern:
 *   1. Get service
 *   2. List user's workflows
 *   3. Semantically match the target workflow
 *   4. Execute the operation
 *   5. Return result via callback
 */

export interface WorkflowActionParams {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  callback?: HandlerCallback;
  /** Identifier for log messages, e.g. "activate" */
  actionLabel: string;
  /** Message shown when user has no workflows */
  noWorkflowsMessage: string;
  /** Callback invoked with the matched workflow ID and service. Return the callback text. */
  execute: (
    service: N8nWorkflowService,
    workflowId: string,
    workflows: N8nWorkflowResponse[]
  ) => Promise<string>;
}

export async function executeWorkflowAction(params: WorkflowActionParams): Promise<ActionResult> {
  const { runtime, message, state, callback, actionLabel, noWorkflowsMessage, execute } = params;
  const logSrc = `plugin:n8n:action:${actionLabel}`;

  const service = runtime.getService<N8nWorkflowService>(N8N_WORKFLOW_SERVICE_TYPE);

  if (!service) {
    logger.error({ src: logSrc }, "N8n Workflow service not available");
    if (callback) {
      await callback({ text: "N8n Workflow service is not available.", success: false });
    }
    return { success: false };
  }

  try {
    const userId = message.entityId;
    const workflows = await service.listWorkflows(userId);

    if (workflows.length === 0) {
      if (callback) {
        await callback({ text: noWorkflowsMessage, success: false });
      }
      return { success: false };
    }

    const context = buildConversationContext(message, state);
    const matchResult = await matchWorkflow(runtime, context, workflows);

    if (!matchResult.matchedWorkflowId || matchResult.confidence === "none") {
      const workflowList = matchResult.matches.map((m) => `- ${m.name} (ID: ${m.id})`).join("\n");

      if (callback) {
        await callback({
          text: `Could not identify which workflow you mean. Available workflows:\n${workflowList}`,
          success: false,
        });
      }
      return { success: false };
    }

    const resultText = await execute(service, matchResult.matchedWorkflowId, workflows);

    logger.info({ src: logSrc }, `${actionLabel} workflow ${matchResult.matchedWorkflowId}`);

    if (callback) {
      await callback({ text: resultText, success: true });
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error({ src: logSrc }, `Failed to ${actionLabel} workflow: ${errorMessage}`);

    if (callback) {
      await callback({
        text: `Failed to ${actionLabel} workflow: ${errorMessage}`,
        success: false,
      });
    }

    return { success: false };
  }
}

/** Shared validate: returns true when the workflow service is available. */
export async function validateWorkflowService(runtime: IAgentRuntime): Promise<boolean> {
  return !!runtime.getService(N8N_WORKFLOW_SERVICE_TYPE);
}
