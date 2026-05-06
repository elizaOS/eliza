import {
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  N8N_WORKFLOW_SERVICE_TYPE,
  type N8nWorkflowService,
} from "../services/index";
import { matchWorkflow } from "../utils/generation";
import { buildConversationContext } from "../utils/context";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Show me the execution history for the Stripe workflow",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll fetch the execution history for that workflow.",
        actions: ["GET_N8N_EXECUTIONS"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "How did the email automation run last time?",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Let me check the recent runs for that workflow.",
        actions: ["GET_N8N_EXECUTIONS"],
      },
    },
  ],
];

type GetExecutionsOptions = {
  parameters?: {
    workflowId?: unknown;
    workflowName?: unknown;
    limit?: unknown;
  };
};

export const getExecutionsAction: Action = {
  name: "GET_N8N_EXECUTIONS",
  similes: [
    "GET_EXECUTIONS",
    "SHOW_EXECUTIONS",
    "EXECUTION_HISTORY",
    "WORKFLOW_RUNS",
    "WORKFLOW_EXECUTIONS",
  ],
  description:
    "Get execution history for an n8n workflow. Shows status, start time, and error messages if any. Identifies workflows by ID, name, or semantic description in any language.",
  descriptionCompressed:
    "get execution history n8n workflow show status, start time, error message identify workflow ID, name, semantic description language",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return !!runtime.getService(N8N_WORKFLOW_SERVICE_TYPE);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService<N8nWorkflowService>(
      N8N_WORKFLOW_SERVICE_TYPE,
    );

    if (!service) {
      logger.error(
        { src: "plugin:n8n-workflow:action:get-executions" },
        "N8n Workflow service not available",
      );
      if (callback) {
        await callback({
          text: "N8n Workflow service is not available.",
          success: false,
        });
      }
      return { success: false };
    }

    try {
      const userId = message.entityId;
      const workflows = await service.listWorkflows(userId);

      if (workflows.length === 0) {
        if (callback) {
          await callback({
            text: "No workflows available to check executions for.",
            success: false,
          });
        }
        return { success: false };
      }

      const params =
        (options as GetExecutionsOptions | undefined)?.parameters ?? {};
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.floor(params.limit))
          : 10;
      const workflowIdParam =
        typeof params.workflowId === "string" &&
        params.workflowId.trim().length > 0
          ? params.workflowId.trim()
          : null;
      const workflowNameParam =
        typeof params.workflowName === "string" &&
        params.workflowName.trim().length > 0
          ? params.workflowName.trim().toLowerCase()
          : null;

      const context = buildConversationContext(message, state);
      const matchResult = workflowIdParam
        ? {
            matchedWorkflowId: workflowIdParam,
            confidence: "high" as const,
            matches: workflows.map((workflow) => ({
              id: workflow.id,
              name: workflow.name,
              score: workflow.id === workflowIdParam ? 1 : 0,
            })),
            reason: "workflowId parameter",
          }
        : workflowNameParam
          ? {
              matchedWorkflowId:
                workflows.find((workflow) =>
                  workflow.name.toLowerCase().includes(workflowNameParam),
                )?.id ?? null,
              confidence: "high" as const,
              matches: workflows.map((workflow) => ({
                id: workflow.id,
                name: workflow.name,
                score: workflow.name.toLowerCase().includes(workflowNameParam)
                  ? 1
                  : 0,
              })),
              reason: "workflowName parameter",
            }
          : await matchWorkflow(runtime, context, workflows);

      if (!matchResult.matchedWorkflowId || matchResult.confidence === "none") {
        const workflowList = matchResult.matches
          .map((m) => `- ${m.name} (ID: ${m.id})`)
          .join("\n");

        if (callback) {
          await callback({
            text: `Could not identify which workflow to check. Available workflows:\n${workflowList}`,
            success: false,
          });
        }
        return { success: false };
      }

      const workflowId = matchResult.matchedWorkflowId;
      const executions = await service.getWorkflowExecutions(workflowId, limit);

      logger.info(
        { src: "plugin:n8n-workflow:action:get-executions" },
        `Retrieved ${executions.length} executions for workflow ${workflowId}`,
      );

      if (executions.length === 0) {
        if (callback) {
          await callback({
            text: `No executions found for workflow ${workflowId}. The workflow may not have run yet.`,
            success: true,
          });
        }
        return { success: true, data: { executions: [] } };
      }

      let responseText = `📊 **Execution History** (Last ${executions.length} runs)\n\n`;

      for (const execution of executions) {
        const statusEmoji =
          execution.status === "success"
            ? "✅"
            : execution.status === "error"
              ? "❌"
              : execution.status === "running"
                ? "⏳"
                : "⏸️";

        responseText += `${statusEmoji} ${execution.status.toUpperCase()}\n`;
        responseText += `   Execution ID: ${execution.id}\n`;
        responseText += `   Started: ${new Date(execution.startedAt).toLocaleString()}\n`;

        if (execution.stoppedAt) {
          responseText += `   Finished: ${new Date(execution.stoppedAt).toLocaleString()}\n`;
        }

        if (execution.data?.resultData?.error) {
          responseText += `   Error: ${execution.data.resultData.error.message}\n`;
        }

        responseText += "\n";
      }

      if (callback) {
        await callback({
          text: responseText,
          success: true,
        });
      }

      return {
        success: true,
        data: { executions },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(
        { src: "plugin:n8n-workflow:action:get-executions" },
        `Failed to get executions: ${errorMessage}`,
      );

      if (callback) {
        await callback({
          text: `Failed to get executions: ${errorMessage}`,
          success: false,
        });
      }

      return { success: false };
    }
  },

  parameters: [
    {
      name: "workflowId",
      description: "Exact n8n workflow id to inspect.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "workflowName",
      description: "Workflow name or partial name when id is unknown.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "limit",
      description: "Maximum number of executions to return.",
      required: false,
      schema: { type: "number" as const },
    },
  ],

  examples,
};
