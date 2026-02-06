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
import { type CreatePullRequestParams, createPullRequestSchema, formatZodErrors } from "../types";

const spec = requireActionSpec("CREATE_PULL_REQUEST");

const examples: ActionExample[][] = [
  [
    {
      name: spec.name,
      content: {
        text: "Create a pull request from feature/dark-mode to main with title 'Add dark mode support'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll create a pull request from feature/dark-mode to main.",
        actions: ["CREATE_GITHUB_PULL_REQUEST"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Open a PR to merge my-branch into develop",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Creating a pull request to merge my-branch into develop.",
        actions: ["CREATE_GITHUB_PULL_REQUEST"],
      },
    },
  ],
];

export const createPullRequestAction: Action = {
  name: "CREATE_GITHUB_PULL_REQUEST",
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return text.includes("pull request") || text.includes("pr") || text.includes("merge");
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

      const params: CreatePullRequestParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        title: (state?.title as string) ?? text.slice(0, 100),
        body: (state?.body as string) ?? text,
        head: (state?.head as string) ?? "",
        base: (state?.base as string) ?? service.getConfig().branch ?? "main",
        draft: (state?.draft as boolean) ?? false,
      };

      const validation = createPullRequestSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid pull request parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the pull request due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const pr = await service.createPullRequest(params);

      logger.info(`Created pull request #${pr.number}: ${pr.title}`);

      if (callback) {
        await callback({
          text: `Created pull request #${pr.number}: "${pr.title}"\n\nFrom: ${pr.head.ref}\nTo: ${pr.base.ref}\n\nView it at: ${pr.htmlUrl}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create pull request: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the pull request: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default createPullRequestAction;
