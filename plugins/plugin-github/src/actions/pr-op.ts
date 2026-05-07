/**
 * @module pr-op
 * @description Single router action covering GitHub pull request ops:
 * list and review.
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
import {
  type GitHubActionResult,
  GitHubActions,
  type GitHubPrOp,
} from "../types.js";

type PRState = "open" | "closed" | "all";
type ReviewAction = "approve" | "request-changes" | "comment";

interface PRSummary {
  repo: string;
  number: number;
  title: string;
  author: string | null;
  state: string;
  url: string;
}

export type GitHubPrOpResult =
  | { op: "list"; prs: PRSummary[] }
  | { op: "review"; id: number };

const SUPPORTED_OPS: ReadonlySet<GitHubPrOp> = new Set(["list", "review"]);

const EVENT_BY_ACTION: Record<
  ReviewAction,
  "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

function parseOp(value: unknown): GitHubPrOp | null {
  if (typeof value !== "string") return null;
  return SUPPORTED_OPS.has(value as GitHubPrOp) ? (value as GitHubPrOp) : null;
}

function parseState(value: unknown): PRState {
  return value === "closed" || value === "all" ? value : "open";
}

function parseReviewAction(value: unknown): ReviewAction | null {
  return value === "approve" ||
    value === "request-changes" ||
    value === "comment"
    ? value
    : null;
}

async function runList(
  runtime: IAgentRuntime,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubPrOpResult>> {
  const identity = resolveIdentity(options, "agent");
  const resolved = buildResolvedClient(runtime, identity);
  if ("error" in resolved) {
    await callback?.({ text: resolved.error });
    return { success: false, error: resolved.error };
  }

  const state = parseState(options?.state);
  const author = requireString(options, "author");
  const repo = requireString(options, "repo");
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
      const match = /\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(item.repository_url);
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

  await callback?.({ text: `Found ${prs.length} pull request(s)` });
  return { success: true, data: { op: "list", prs } };
}

async function runReview(
  runtime: IAgentRuntime,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubPrOpResult>> {
  const identity = resolveIdentity(options, "user");
  const repo = requireString(options, "repo");
  const number = requireNumber(options, "number");
  const action = parseReviewAction(options?.action);
  const body = requireString(options, "body");

  if (!repo || !number || !action) {
    const err =
      "GITHUB_PR_OP review requires repo (owner/name), number (integer), and action (approve|request-changes|comment)";
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

  if (action === "request-changes" && !body) {
    const err = "request-changes review requires a body explaining the changes";
    await callback?.({ text: err });
    return { success: false, error: err };
  }

  const resolved = buildResolvedClient(runtime, identity);
  if ("error" in resolved) {
    await callback?.({ text: resolved.error });
    return { success: false, error: resolved.error };
  }

  const resp = await resolved.client.pulls.createReview({
    owner: parts.owner,
    repo: parts.name,
    pull_number: number,
    event: EVENT_BY_ACTION[action],
    body: body ?? undefined,
  });
  await callback?.({ text: `Submitted ${action} review on ${repo}#${number}` });
  return { success: true, data: { op: "review", id: resp.data.id } };
}

export const prOpAction: Action = {
  name: GitHubActions.GITHUB_PR_OP,
  contexts: ["code", "tasks", "connectors", "automation"],
  contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "LIST_PRS",
    "LIST_PULL_REQUESTS",
    "SHOW_PRS",
    "GITHUB_LIST_PRS",
    "REVIEW_PR",
    "APPROVE_PR",
    "REQUEST_CHANGES",
    "COMMENT_ON_PR",
  ],
  description:
    "Single router for GitHub PR ops: list and review. Review requires confirmed:true.",
  descriptionCompressed:
    "GitHub PR ops: list pull requests, submit review with confirmation.",
  parameters: [
    {
      name: "op",
      description: "PR operation: list or review.",
      required: true,
      schema: { type: "string", enum: [...SUPPORTED_OPS] },
    },
    {
      name: "repo",
      description: "Repository in owner/name form.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "number",
      description: "Pull request number for review.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "state",
      description: "PR state for list.",
      required: false,
      schema: {
        type: "string",
        enum: ["open", "closed", "all"],
        default: "open",
      },
    },
    {
      name: "author",
      description: "Optional PR author username filter for list.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "action",
      description: "Review action: approve, request-changes, or comment.",
      required: false,
      schema: {
        type: "string",
        enum: ["approve", "request-changes", "comment"],
      },
    },
    {
      name: "body",
      description: "Review body for comment or request-changes.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "as",
      description: "Identity to use: agent or user.",
      required: false,
      schema: { type: "string", enum: ["agent", "user"], default: "agent" },
    },
    {
      name: "confirmed",
      description: "Must be true to submit a review.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],

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
  ): Promise<GitHubActionResult<GitHubPrOpResult>> => {
    const op = parseOp(options?.op);
    if (!op) {
      const err = "GITHUB_PR_OP requires op (list|review)";
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    try {
      return op === "list"
        ? await runList(runtime, options, callback)
        : await runReview(runtime, options, callback);
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `GITHUB_PR_OP ${op} failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:GITHUB_PR_OP]");
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
    [
      {
        name: "{{user1}}",
        content: { text: "Approve PR #42 on elizaOS/eliza" },
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
