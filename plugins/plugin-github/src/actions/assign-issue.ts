/**
 * @module assign-issue
 * @description Adds assignees to an existing issue. Gated on confirmed:true.
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
  requireStringArray,
  resolveIdentity,
  splitRepo,
} from "../action-helpers.js";
import {
  errorMessage,
  formatRateLimitMessage,
  inspectRateLimit,
} from "../rate-limit.js";
import { type GitHubActionResult, GitHubActions } from "../types.js";

export const assignIssueAction: Action = {
  name: GitHubActions.ASSIGN_ISSUE,
  similes: ["ASSIGN_GITHUB_ISSUE", "ADD_ASSIGNEE"],
  description:
    "Assigns one or more users to a GitHub issue or PR. Requires confirmed:true.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const r = buildResolvedClient(runtime, "agent");
    return !("error" in r);
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<GitHubActionResult<{ assignees: string[] }>> => {
    const identity = resolveIdentity(options, "agent");
    const repo = requireString(options, "repo");
    const number = requireNumber(options, "number");
    const assignees = requireStringArray(options, "assignees");

    if (!repo || !number || !assignees || assignees.length === 0) {
      const err =
        "ASSIGN_ISSUE requires repo (owner/name), number (integer), and assignees (non-empty string[])";
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
        `About to assign [${assignees.join(", ")}] to ${repo}#${number} as ${identity}.` +
        " Re-invoke with confirmed: true to proceed.";
      await callback?.({ text: preview });
      return { success: false, requiresConfirmation: true, preview };
    }

    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    try {
      const resp = await resolved.client.issues.addAssignees({
        owner: parts.owner,
        repo: parts.name,
        issue_number: number,
        assignees,
      });
      const responseData = resp.data as {
        assignees?: Array<{ login?: string | null } | null>;
      };
      const actual = (responseData.assignees ?? [])
        .map((a) => a?.login)
        .filter((x): x is string => typeof x === "string");
      await callback?.({
        text: `Assigned [${actual.join(", ")}] to ${repo}#${number}`,
      });
      return { success: true, data: { assignees: actual } };
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `ASSIGN_ISSUE failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:ASSIGN_ISSUE]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Assign alice to elizaOS/eliza#42",
        },
      },
      {
        name: "{{agentName}}",
        content: { text: "Assigned [alice] to elizaOS/eliza#42" },
      },
    ],
  ],
};
