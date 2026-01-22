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
import {
  type CreateCommitParams,
  createCommitSchema,
  type FileChange,
  formatZodErrors,
} from "../types";

const spec = requireActionSpec("PUSH_CODE");

const examples: ActionExample[][] = [
  [
    {
      name: spec.name,
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
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
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

      const files = (state?.files as FileChange[]) ?? [];

      const params: CreateCommitParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        message: (state?.message as string) ?? text.slice(0, 100),
        files,
        branch: (state?.branch as string) ?? service.getConfig().branch ?? "main",
        authorName: state?.authorName as string | undefined,
        authorEmail: state?.authorEmail as string | undefined,
      };

      const validation = createCommitSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid commit parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't push the code due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const commit = await service.createCommit(params);

      logger.info(`Created commit ${commit.sha.slice(0, 7)} on ${params.branch}`);

      if (callback) {
        await callback({
          text: `Pushed ${files.length} file(s) to ${params.branch}.\n\nCommit: ${commit.sha.slice(0, 7)}\nMessage: ${commit.message}\n\nView at: ${commit.htmlUrl}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to push code: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to push the code: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default pushCodeAction;
