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
import { type CreateCommentParams, createCommentSchema, formatZodErrors } from "../types";

const spec = requireActionSpec("CREATE_COMMENT");

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
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return text.includes("comment") || text.includes("reply") || text.includes("respond");
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
      const text = content.text ?? "";

      const params: CreateCommentParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        issueNumber: (state?.issueNumber as number) ?? 0,
        body: (state?.body as string) ?? text,
      };

      const validation = createCommentSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid comment parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the comment due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const comment = await service.createComment(params);

      logger.info(`Created comment on #${params.issueNumber}`);

      if (callback) {
        await callback({
          text: `Added comment to #${params.issueNumber}.\n\nView it at: ${comment.htmlUrl}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create comment: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the comment: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default createCommentAction;
