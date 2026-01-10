/**
 * Create Comment Action
 *
 * Creates a comment on a GitHub issue or pull request.
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
import { createCommentSchema, type CreateCommentParams } from "../types";
import { GitHubService, GITHUB_SERVICE_NAME } from "../service";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Comment on issue #42 saying 'I'll take a look at this today'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll add that comment to issue #42.",
        actions: ["CREATE_GITHUB_COMMENT"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Reply to PR #15 with 'Thanks for the fix!'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Adding your comment to pull request #15.",
        actions: ["CREATE_GITHUB_COMMENT"],
      },
    },
  ],
];

export const createCommentAction: Action = {
  name: "CREATE_GITHUB_COMMENT",
  similes: [
    "COMMENT_ON_ISSUE",
    "COMMENT_ON_PR",
    "ADD_COMMENT",
    "REPLY_TO_ISSUE",
    "POST_COMMENT",
  ],
  description: "Creates a comment on a GitHub issue or pull request.",

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
      text.includes("comment") ||
      text.includes("reply") ||
      text.includes("respond")
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

      const params: CreateCommentParams = {
        owner: (state?.["owner"] as string) ?? service.getConfig().owner ?? "",
        repo: (state?.["repo"] as string) ?? service.getConfig().repo ?? "",
        issueNumber: (state?.["issueNumber"] as number) ?? 0,
        body: (state?.["body"] as string) ?? text,
      };

      const validation = createCommentSchema.safeParse(params);
      if (!validation.success) {
        const errors = validation.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ");
        logger.error(`Invalid comment parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the comment due to missing information: ${errors}`,
          });
        }
        return { success: false, error: errors };
      }

      const comment = await service.createComment(params);

      logger.info(`Created comment on #${params.issueNumber}`);

      if (callback) {
        await callback({
          text: `Added comment to #${params.issueNumber}.\n\nView it at: ${comment.htmlUrl}`,
        });
      }

      return { success: true, data: { commentId: comment.id, htmlUrl: comment.htmlUrl } };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create comment: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the comment: ${errorMessage}`,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples,
};

export default createCommentAction;
