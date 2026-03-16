import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import { GITHUB_SERVICE_NAME, type GitHubService } from "../service";
import { formatZodErrors, type MergePullRequestParams, mergePullRequestSchema } from "../types";

const spec = requireActionSpec("MERGE_PULL_REQUEST");

const examples: ActionExample[][] = [
  [
    {
      name: spec.name,
      content: {
        text: "Merge pull request #42",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll merge pull request #42.",
        actions: ["MERGE_GITHUB_PULL_REQUEST"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Squash and merge PR #15 with title 'Feature: Add dark mode'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Squash merging pull request #15 with your custom commit title.",
        actions: ["MERGE_GITHUB_PULL_REQUEST"],
      },
    },
  ],
];

export const mergePullRequestAction: Action = {
  name: "MERGE_GITHUB_PULL_REQUEST",
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return text.includes("merge");
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<GitHubService>(GITHUB_SERVICE_NAME);

    if (!service) {
      logger.error("GitHub service not available");
      if (callback) {
        await callback({
          text: "GitHub service is not available. Please ensure the plugin is properly configured.",
        });
      }
      return { success: false };
    }

    try {
      const content = message.content as Content;
      const text = content.text?.toLowerCase() ?? "";

      let mergeMethod: "merge" | "squash" | "rebase" = "merge";
      if (text.includes("squash")) {
        mergeMethod = "squash";
      } else if (text.includes("rebase")) {
        mergeMethod = "rebase";
      }

      const params: MergePullRequestParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        pullNumber: (state?.pullNumber as number) ?? 0,
        commitTitle: state?.commitTitle as string | undefined,
        commitMessage: state?.commitMessage as string | undefined,
        mergeMethod: (state?.mergeMethod as "merge" | "squash" | "rebase") ?? mergeMethod,
      };

      const validation = mergePullRequestSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid merge parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't merge the pull request due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const result = await service.mergePullRequest(params);

      if (result.merged) {
        logger.info(`Merged pull request #${params.pullNumber}`);
        if (callback) {
          await callback({
            text: `Successfully merged pull request #${params.pullNumber}.\n\nMerge commit: ${result.sha.slice(0, 7)}\nMethod: ${params.mergeMethod}`,
          });
        }
        return { success: true };
      } else {
        logger.warn(`Pull request #${params.pullNumber} was not merged: ${result.message}`);
        if (callback) {
          await callback({
            text: `Could not merge pull request #${params.pullNumber}: ${result.message}`,
          });
        }
        return { success: false };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to merge pull request: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to merge the pull request: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default mergePullRequestAction;
