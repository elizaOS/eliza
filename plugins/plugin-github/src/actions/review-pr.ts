/**
 * @module review-pr
 * @description Submits a review on a pull request. `approve` and
 * `request-changes` are destructive from a human-approval standpoint, so
 * they require an explicit `confirmed: true` flag. `comment` is also gated
 * to keep the user loop consistent.
 *
 * Defaults to the `user` identity: PR review is a human-approval action and
 * should not originate from the agent token unless explicitly requested.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  buildResolvedClient,
  isConfirmed,
  requireNumber,
  requireString,
  resolveIdentity,
  splitRepo,
} from "../action-helpers.js";
import {
  errorMessage,
  formatRateLimitMessage,
  inspectRateLimit,
} from "../rate-limit.js";
import { type GitHubActionResult, GitHubActions } from "../types.js";

type ReviewAction = "approve" | "request-changes" | "comment";

function parseAction(value: unknown): ReviewAction | null {
  return value === "approve" ||
    value === "request-changes" ||
    value === "comment"
    ? value
    : null;
}

const EVENT_BY_ACTION: Record<
  ReviewAction,
  "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

export const reviewPrAction: Action = {
  name: GitHubActions.REVIEW_PR,
  similes: ["APPROVE_PR", "REQUEST_CHANGES", "COMMENT_ON_PR"],
  description:
    "Submits a review on a GitHub PR (approve, request-changes, or comment). Approve and request-changes require confirmed:true.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const r = buildResolvedClient(runtime, "user");
    return !("error" in r);
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<GitHubActionResult<{ id: number }>> => {
    const identity = resolveIdentity(options, "user");
    const repo = requireString(options, "repo");
    const number = requireNumber(options, "number");
    const action = parseAction(options?.action);
    const body = requireString(options, "body");

    if (!repo || !number || !action) {
      const err =
        "REVIEW_PR requires repo (owner/name), number (integer), and action (approve|request-changes|comment)";
      await callback?.({ text: err });
      return { success: false, error: err };
    }
    const parts = splitRepo(repo);
    if (!parts) {
      const err = `Invalid repo "${repo}" — expected "owner/name"`;
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    if (!isConfirmed(options)) {
      const preview =
        `About to ${action.replace("-", " ")} PR ${repo}#${number}` +
        (body ? ` with body: "${body.slice(0, 120)}"` : "") +
        ` as ${identity}. Re-invoke with confirmed: true to proceed.`;
      await callback?.({ text: preview });
      return { success: false, requiresConfirmation: true, preview };
    }

    if (action !== "comment" && !body && action === "request-changes") {
      const err =
        "request-changes review requires a body explaining the changes";
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    try {
      const resp = await resolved.client.pulls.createReview({
        owner: parts.owner,
        repo: parts.name,
        pull_number: number,
        event: EVENT_BY_ACTION[action],
        body: body ?? undefined,
      });
      await callback?.({
        text: `Submitted ${action} review on ${repo}#${number}`,
      });
      return { success: true, data: { id: resp.data.id } };
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `REVIEW_PR failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:REVIEW_PR]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Approve PR #42 on elizaOS/eliza",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Submitted approve review on elizaOS/eliza#42",
        },
      },
    ],
  ],
};
