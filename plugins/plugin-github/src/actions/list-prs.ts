/**
 * @module list-prs
 * @description Lists pull requests either within a single repo or across all
 * repos the configured token can see (via the search API).
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

type PRState = "open" | "closed" | "all";

interface PRSummary {
  repo: string;
  number: number;
  title: string;
  author: string | null;
  state: string;
  url: string;
}

function parseState(value: unknown): PRState {
  return value === "closed" || value === "all" ? value : "open";
}

export const listPrsAction: Action = {
  name: GitHubActions.LIST_PRS,
  similes: ["LIST_PULL_REQUESTS", "SHOW_PRS", "GITHUB_LIST_PRS"],
  description:
    "Lists GitHub pull requests — either within a specific repo or across all accessible repos, optionally filtered by state and author.",

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
  ): Promise<GitHubActionResult<{ prs: PRSummary[] }>> => {
    const identity = resolveIdentity(options, "agent");
    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    const state = parseState(options?.state);
    const author = requireString(options, "author");
    const repo = requireString(options, "repo");

    try {
      const prs: PRSummary[] = [];
      if (repo) {
        const parts = splitRepo(repo);
        if (!parts) {
          const err = `Invalid repo "${repo}" — expected "owner/name"`;
          await callback?.({ text: err });
          return { success: false, error: err };
        }
        const resp = await resolved.client.pulls.list({
          owner: parts.owner,
          repo: parts.name,
          state,
          per_page: 100,
        });
        for (const pr of resp.data) {
          if (author && pr.user?.login !== author) {
            continue;
          }
          prs.push({
            repo,
            number: pr.number,
            title: pr.title,
            author: pr.user?.login ?? null,
            state: pr.state,
            url: pr.html_url,
          });
        }
      } else {
        const q = [
          "is:pr",
          state === "all" ? "" : `is:${state}`,
          author ? `author:${author}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        const resp = await resolved.client.search.issuesAndPullRequests({
          q,
          per_page: 50,
        });
        for (const item of resp.data.items) {
          const match = /\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(
            item.repository_url,
          );
          const repoName = match?.[1] ?? item.repository_url;
          prs.push({
            repo: repoName,
            number: item.number,
            title: item.title,
            author: item.user?.login ?? null,
            state: item.state,
            url: item.html_url,
          });
        }
      }

      await callback?.({
        text: `Found ${prs.length} pull request(s)`,
      });
      return { success: true, data: { prs } };
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `LIST_PRS failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:LIST_PRS]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me open PRs on elizaOS/eliza" },
      },
      {
        name: "{{agentName}}",
        content: { text: "Found 3 pull request(s)" },
      },
    ],
  ],
};
