/**
 * Review Pull Request Action
 *
 * Creates a review on a GitHub pull request.
 */

import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { GITHUB_SERVICE_NAME, type GitHubService } from "../service";
import { type CreateReviewParams, createReviewSchema, formatZodErrors } from "../types";

const examples: ActionExample[][] = [
  [
    {
      name: "{{user1}}",
      content: {
        text: "Approve pull request #42 with comment 'LGTM!'",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll approve pull request #42 with that comment.",
        actions: ["REVIEW_GITHUB_PULL_REQUEST"],
      },
    },
  ],
  [
    {
      name: "{{user1}}",
      content: {
        text: "Request changes on PR #15 - the tests are failing",
      },
    },
    {
      name: "{{agent}}",
      content: {
        text: "I'll request changes on pull request #15 with your feedback.",
        actions: ["REVIEW_GITHUB_PULL_REQUEST"],
      },
    },
  ],
];

export const reviewPullRequestAction: Action = {
  name: "REVIEW_GITHUB_PULL_REQUEST",
  similes: [
    "APPROVE_PR",
    "REQUEST_CHANGES",
    "COMMENT_ON_PR",
    "REVIEW_PR",
    "PR_REVIEW",
    "CODE_REVIEW",
  ],
  description:
    "Creates a review on a GitHub pull request. Can approve, request changes, or add comments.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService(GITHUB_SERVICE_NAME);
    if (!service) {
      return false;
    }

    const text = (message.content as Content).text?.toLowerCase() ?? "";
    return (
      text.includes("review") ||
      text.includes("approve") ||
      text.includes("request changes") ||
      text.includes("lgtm")
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: Record<string, unknown>,
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

      // Determine review event type from text
      let event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" = "COMMENT";
      const lowerText = text.toLowerCase();
      if (
        lowerText.includes("approve") ||
        lowerText.includes("lgtm") ||
        lowerText.includes("looks good")
      ) {
        event = "APPROVE";
      } else if (
        lowerText.includes("request changes") ||
        lowerText.includes("needs work") ||
        lowerText.includes("fix")
      ) {
        event = "REQUEST_CHANGES";
      }

      const params: CreateReviewParams = {
        owner: (state?.owner as string) ?? service.getConfig().owner ?? "",
        repo: (state?.repo as string) ?? service.getConfig().repo ?? "",
        pullNumber: (state?.pullNumber as number) ?? 0,
        body: (state?.body as string) ?? text,
        event: (state?.event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT") ?? event,
      };

      const validation = createReviewSchema.safeParse(params);
      if (!validation.success) {
        const errors = formatZodErrors(validation.error);
        logger.error(`Invalid review parameters: ${errors}`);
        if (callback) {
          await callback({
            text: `I couldn't create the review due to missing information: ${errors}`,
          });
        }
        return { success: false };
      }

      const review = await service.createReview(params);

      const eventLabel =
        review.state === "APPROVED"
          ? "approved"
          : review.state === "CHANGES_REQUESTED"
            ? "requested changes on"
            : "commented on";

      logger.info(`Created ${review.state} review on PR #${params.pullNumber}`);

      if (callback) {
        await callback({
          text: `I've ${eventLabel} pull request #${params.pullNumber}.\n\nView the review at: ${review.htmlUrl}`,
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`Failed to create review: ${errorMessage}`);

      if (callback) {
        await callback({
          text: `Failed to create the review: ${errorMessage}`,
        });
      }

      return { success: false };
    }
  },

  examples,
};

export default reviewPullRequestAction;
