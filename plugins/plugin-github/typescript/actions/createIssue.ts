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
import { type CreateIssueParams, createIssueSchema, formatZodErrors } from "../types";

const spec = requireActionSpec("CREATE_ISSUE");

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Create an issue in my-org/my-repo with title 'Bug: Login fails' and body 'Users cannot log in after update'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll create that issue for you in my-org/my-repo.",
        actions: ["CREATE_GITHUB_ISSUE"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Open a new issue titled 'Add dark mode support' with labels 'enhancement' and 'ui'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "Creating a new issue with the title 'Add dark mode support' and the specified labels.",
        actions: ["CREATE_GITHUB_ISSUE"],
      },
    },
  ],
];

export const createIssueAction: Action = {
  name: "CREATE_GITHUB_ISSUE",
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return (
      text.includes("issue") ||
      text.includes("bug") ||
      text.includes("report") ||
      text.includes("ticket")
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

      const params: CreateIssueParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        title: (state?.title as string) ?? text.slice(0, 100),
        body: (state?.body as string) ?? text,
        labels: (state?.labels as string[]) ?? [],
        assignees: (state?.assignees as string[]) ?? [],
      };

      const validation = createIssueSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid issue parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the issue due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const issue = await service.createIssue(params);

      logger.info(`Created issue #${issue.number}: ${issue.title}`);

      if (callback) {
        await callback({
          text: `Created issue #${issue.number}: "${issue.title}"\n\nView it at: ${issue.htmlUrl}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create issue: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the issue: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default createIssueAction;
