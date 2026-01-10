/**
 * Create Branch Action
 *
 * Creates a new branch in a GitHub repository.
 */

import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { createBranchSchema, type CreateBranchParams } from "../types";
import { GitHubService, GITHUB_SERVICE_NAME } from "../service";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Create a branch called feature/new-feature from main",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll create the feature/new-feature branch from main.",
        actions: ["CREATE_GITHUB_BRANCH"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Make a new branch fix/bug-123 based on develop",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Creating branch fix/bug-123 from develop.",
        actions: ["CREATE_GITHUB_BRANCH"],
      },
    },
  ],
];

export const createBranchAction: Action = {
  name: "CREATE_GITHUB_BRANCH",
  similes: [
    "NEW_BRANCH",
    "BRANCH_FROM",
    "FORK_BRANCH",
    "CREATE_FEATURE_BRANCH",
  ],
  description:
    "Creates a new branch in a GitHub repository from an existing branch or commit.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return (
      text.includes("branch") ||
      text.includes("fork") ||
      text.includes("checkout")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const service = runtime.getService<GitHubService>(GITHUB_SERVICE_NAME);

    if (!service) {
      logger.error("GitHub service not available");
      if (callback) {
        await callback({
          text: "GitHub service is not available. Please ensure the plugin is properly configured.",
        });
      }
      return { success: false, error: "GitHub service not available" };
    }

    try {
      const params: CreateBranchParams = {
        owner: (state?.["owner"] as string) ?? service.getConfig().owner ?? "",
        repo: (state?.["repo"] as string) ?? service.getConfig().repo ?? "",
        branchName: (state?.["branchName"] as string) ?? "",
        fromRef: (state?.["fromRef"] as string) ?? service.getConfig().branch ?? "main",
      };

      const validation = createBranchSchema.safeParse(params);
      if (!validation.success) {
        const errors = validation.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        logger.error(`Invalid branch parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the branch due to missing information: ${errors}`,
          });
        }
        return { success: false, error: errors };
      }

      const branch = await service.createBranch(params);

      logger.info(`Created branch ${branch.name} from ${params.fromRef}`);

      if (callback) {
        await callback({
          text: `Created branch "${branch.name}" from ${params.fromRef}.\n\nLatest commit: ${branch.sha.slice(0, 7)}`,
        });
      }

      return { success: true, data: { branchName: branch.name, sha: branch.sha } };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create branch: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the branch: ${errorMessage}`,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples,
};

export default createBranchAction;
