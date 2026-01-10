/**
 * Create Issue Action
 *
 * Creates a new issue in a GitHub repository.
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
import { z, ZodError } from "zod";
import { createIssueSchema, type CreateIssueParams } from "../types";
import { GitHubService, GITHUB_SERVICE_NAME } from "../service";

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
  similes: [
    "OPEN_ISSUE",
    "NEW_ISSUE",
    "FILE_ISSUE",
    "REPORT_BUG",
    "CREATE_BUG_REPORT",
    "SUBMIT_ISSUE",
  ],
  description:
    "Creates a new issue in a GitHub repository. Use this to report bugs, request features, or track tasks.",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    // Check if GitHub service is available
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    // Check if message contains issue-related content
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
      // Extract issue details from the message
      // In a real implementation, you would use the LLM to extract structured data
      const content = message.content as Content;
      const text = content.text ?? "";

      // For now, use a simple extraction - in production, use LLM
      const params: CreateIssueParams = {
        owner: (state?.["owner"] as string) ?? service.getConfig().owner ?? "",
        repo: (state?.["repo"] as string) ?? service.getConfig().repo ?? "",
        title: (state?.["title"] as string) ?? text.slice(0, 100),
        body: (state?.["body"] as string) ?? text,
        labels: (state?.["labels"] as string[]) ?? [],
        assignees: (state?.["assignees"] as string[]) ?? [],
      };

      // Validate params
      const validation = createIssueSchema.safeParse(params);
      if (!validation.success) {
        const formattedErrors = validation.error.format();
        const errors = Object.entries(formattedErrors)
          .filter(([key]) => key !== '_errors')
          .map(([key, value]) => `${key}: ${(value as { _errors?: string[] })?._errors?.join(', ') ?? 'invalid'}`)
          .join(', ') || 'Invalid parameters';
        logger.error(`Invalid issue parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the issue due to missing information: ${errors}`,
          });
        }
        return { success: false, error: errors };
      }

      // Create the issue
      const issue = await service.createIssue(params);

      logger.info(`Created issue #${issue.number}: ${issue.title}`);

      if (callback) {
        await callback({
          text: `Created issue #${issue.number}: "${issue.title}"\n\nView it at: ${issue.htmlUrl}`,
        });
      }

      return { 
        success: true, 
        data: { 
          issueNumber: issue.number, 
          htmlUrl: issue.htmlUrl 
        } 
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create issue: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the issue: ${errorMessage}`,
        });
      }

      return { success: false, error: errorMessage };
    }
  },

  examples,
};

export default createIssueAction;
