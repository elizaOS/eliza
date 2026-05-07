import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  requireConfirmation,
  type State,
} from "@elizaos/core";
import { deleteIssueTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";
import type { DeleteIssueParameters } from "../types/index.js";
import { getStringValue, parseLinearPromptResponse } from "./parseLinearPrompt.js";
import { validateLinearActionIntent } from "./validate-linear-intent";

const LINEAR_MODEL_TIMEOUT_MS = 15_000;
const LINEAR_ISSUE_TITLE_MAX_CHARS = 300;

export const deleteIssueAction: Action = {
  name: "DELETE_LINEAR_ISSUE",
  contexts: ["tasks", "connectors", "automation"],
  contextGate: { anyOf: ["tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  description: "Delete (archive) an issue in Linear",
  descriptionCompressed: "delete (archive) issue Linear",
  parameters: [
    {
      name: "issueId",
      description: "Linear issue id or identifier to archive.",
      required: false,
      schema: { type: "string" },
    },
  ],
  similes: [
    "delete-linear-issue",
    "archive-linear-issue",
    "remove-linear-issue",
    "close-linear-issue",
  ],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Delete issue ENG-123",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll archive issue ENG-123 for you.",
          actions: ["DELETE_LINEAR_ISSUE"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Remove COM2-7 from Linear",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll archive issue COM2-7 in Linear.",
          actions: ["DELETE_LINEAR_ISSUE"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Archive the bug report BUG-456",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll archive issue BUG-456 for you.",
          actions: ["DELETE_LINEAR_ISSUE"],
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> =>
    validateLinearActionIntent(runtime, message, state, {
      keywords: ["delete", "linear", "issue"],
      regexAlternation: "delete|linear|issue",
    }),

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      const content = message.content.text;
      if (!content) {
        const errorMessage = "Please specify which issue to delete.";
        await callback?.({
          text: errorMessage,
          source: message.content.source,
        });
        return {
          text: errorMessage,
          success: false,
        };
      }

      let issueId: string;

      const params = _options?.parameters as DeleteIssueParameters | undefined;
      if (params?.issueId) {
        issueId = params.issueId;
      } else {
        const prompt = deleteIssueTemplate.replace("{{userMessage}}", content);

        const response = await Promise.race([
          runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: prompt,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Linear issue extraction timeout")),
              LINEAR_MODEL_TIMEOUT_MS
            )
          ),
        ]);

        if (!response) {
          throw new Error("Failed to extract issue identifier");
        }

        try {
          const parsed = parseLinearPromptResponse(response);
          if (Object.keys(parsed).length === 0) {
            throw new Error("No fields found in model response");
          }

          issueId = getStringValue(parsed.issueId) ?? "";
          if (!issueId) {
            throw new Error("Issue ID not found in parsed response");
          }
        } catch (parseError) {
          logger.warn("Failed to parse LLM response, falling back to regex parsing:", parseError);

          const issueMatch = content.match(/(\w+-\d+)/);
          if (!issueMatch) {
            const errorMessage = "Please specify an issue ID (e.g., ENG-123) to delete.";
            await callback?.({
              text: errorMessage,
              source: message.content.source,
            });
            return {
              text: errorMessage,
              success: false,
            };
          }

          issueId = issueMatch[1];
        }
      }

      const issue = await linearService.getIssue(issueId);
      const issueTitle = issue.title.slice(0, LINEAR_ISSUE_TITLE_MAX_CHARS);
      const issueIdentifier = issue.identifier;

      // Two-phase confirmation: archiving a Linear issue is irreversible
      // from the agent's side, so always ask the user to confirm.
      const decision = await requireConfirmation({
        runtime,
        message,
        actionName: "DELETE_LINEAR_ISSUE",
        pendingKey: `archive:${issue.id}`,
        prompt: `Archive issue ${issueIdentifier}: "${issueTitle}"? This moves it out of active views. Reply "yes" to confirm.`,
        callback,
      });
      if (decision.status === "pending") {
        return {
          text: `Awaiting confirmation to archive ${issueIdentifier}.`,
          success: true,
          data: { awaitingUserInput: true, issueId: issue.id, identifier: issueIdentifier },
        };
      }
      if (decision.status === "cancelled") {
        const cancelMessage = `Archive of ${issueIdentifier} cancelled.`;
        await callback?.({ text: cancelMessage, source: message.content.source });
        return {
          text: cancelMessage,
          success: true,
          data: { cancelled: true, issueId: issue.id, identifier: issueIdentifier },
        };
      }

      logger.info(`Archiving issue ${issueIdentifier}: ${issueTitle}`);

      await linearService.deleteIssue(issueId);

      const successMessage = `✅ Successfully archived issue ${issueIdentifier}: "${issueTitle}"\n\nThe issue has been moved to the archived state and will no longer appear in active views.`;
      await callback?.({
        text: successMessage,
        source: message.content.source,
      });

      return {
        text: `Archived issue ${issueIdentifier}: "${issueTitle}"`,
        success: true,
        data: {
          issueId: issue.id,
          identifier: issueIdentifier,
          title: issueTitle,
          archived: true,
        },
      };
    } catch (error) {
      logger.error("Failed to delete issue:", error);
      const errorMessage = `❌ Failed to delete issue: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
