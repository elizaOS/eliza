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
import { type CreateBranchParams, createBranchSchema, formatZodErrors } from "../types";

const spec = requireActionSpec("CREATE_BRANCH");

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
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return text.includes("branch") || text.includes("fork") || text.includes("checkout");
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
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
      const params: CreateBranchParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        branchName: (state?.branchName as string) ?? "",
        fromRef: (state?.fromRef as string) ?? service.getConfig().branch ?? "main",
      };

      const validation = createBranchSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid branch parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the branch due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const branch = await service.createBranch(params);

      logger.info(`Created branch ${branch.name} from ${params.fromRef}`);

      if (callback) {
        await callback({
          text: `Created branch "${branch.name}" from ${params.fromRef}.\n\nLatest commit: ${branch.sha.slice(0, 7)}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create branch: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the branch: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default createBranchAction;
