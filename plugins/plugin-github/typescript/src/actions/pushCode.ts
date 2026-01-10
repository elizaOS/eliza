/**
 * Push Code Action
 *
 * Creates a commit with file changes and pushes to a branch.
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
import { createCommitSchema, type CreateCommitParams, type FileChange } from "../types";
import { GitHubService, GITHUB_SERVICE_NAME } from "../service";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Push the file changes to the feature/dark-mode branch with message 'Add dark mode styles'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll commit and push those changes to feature/dark-mode.",
        actions: ["PUSH_GITHUB_CODE"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Commit these files to main: README.md with content 'Hello World'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Committing README.md to main branch.",
        actions: ["PUSH_GITHUB_CODE"],
      },
    },
  ],
];

export const pushCodeAction: Action = {
  name: "PUSH_GITHUB_CODE",
  similes: [
    "COMMIT_CODE",
    "PUSH_CHANGES",
    "COMMIT_FILES",
    "PUSH_FILES",
    "GIT_PUSH",
    "SAVE_CODE",
  ],
  description:
    "Creates a commit with file changes and pushes to a GitHub branch.",

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
      text.includes("push") ||
      text.includes("commit") ||
      text.includes("save") ||
      text.includes("upload")
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
      const content = message.content as Content;
      const text = content.text ?? "";

      const files = (state?.["files"] as FileChange[]) ?? [];

      const params: CreateCommitParams = {
        owner: (state?.["owner"] as string) ?? service.getConfig().owner ?? "",
        repo: (state?.["repo"] as string) ?? service.getConfig().repo ?? "",
        message: (state?.["message"] as string) ?? text.slice(0, 100),
        files,
        branch: (state?.["branch"] as string) ?? service.getConfig().branch ?? "main",
        authorName: state?.["authorName"] as string | undefined,
        authorEmail: state?.["authorEmail"] as string | undefined,
      };

      const validation = createCommitSchema.safeParse(params);
      if (!validation.success) {
        const errors = validation.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        logger.error(`Invalid commit parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't push the code due to missing information: ${errors}`,
          });
        }
        return { success: false, error: errors };
      }

      const commit = await service.createCommit(params);

      logger.info(`Created commit ${commit.sha.slice(0, 7)} on ${params.branch}`);

      if (callback) {
        await callback({
          text: `Pushed ${files.length} file(s) to ${params.branch}.\n\nCommit: ${commit.sha.slice(0, 7)}\nMessage: ${commit.message}\n\nView at: ${commit.htmlUrl}`,
        });
      }

      return { success: true, data: { sha: commit.sha, htmlUrl: commit.htmlUrl } };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to push code: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to push the code: ${errorMessage}`,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples,
};

export default pushCodeAction;
