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
import { ElizaError, logger, toWellFormedUnicode } from "@elizaos/core";
import {
  buildResolvedClient,
  confirmPreviewedRequest,
  describeSelection,
  requireNumber,
  requireString,
  resolveAccountSelection,
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

/** Build the complete confirmation text shown before a PR review mutation. */
export function buildReviewPreview(
  action: ReviewAction,
  repo: string,
  number: number,
  body: string | null | undefined,
  identity: string,
): string {
  return (
    `About to ${action.replace("-", " ")} PR ${repo}#${number}` +
    (body ? ` with body: "${toWellFormedUnicode(body)}"` : "") +
    ` as ${identity}.`
  );
}

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
  | { op: "review"; id: number }
  | { requiresConfirmation: true; preview: string; awaitingUserInput: true }
  | { cancelled: true };

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
  const selection = resolveAccountSelection(options, "agent");
  const resolved = await buildResolvedClient(runtime, selection);
  if ("error" in resolved) {
    await callback?.({ text: resolved.error });
    return { success: false, error: resolved.error };
  }

  const state = parseState(options?.state);
  const author = requireString(options, "author");
  const repo = requireString(options, "repo");
  const prs: PRSummary[] = [];

  // Without a repo or an author the search query matches every PR on GitHub,
  // which the search API cannot return in full.
  if (!repo && !author) {
    const err =
      "PR list requires repo (owner/name) or author (a GitHub login, or @me for the token's own account)";
    await callback?.({ text: err });
    return { success: false, error: err };
  }

  const parts = repo ? splitRepo(repo) : null;
  if (repo && !parts) {
    const err = `Invalid repo "${repo}" — expected "owner/name"`;
    await callback?.({ text: err });
    return { success: false, error: err };
  }

  if (repo && parts && !author) {
    for (let page = 1; ; page++) {
      const resp = await resolved.client.pulls.list({
        owner: parts.owner,
        repo: parts.name,
        state,
        per_page: 100,
        page,
        sort: "created",
        direction: "asc",
      });
      for (const pr of resp.data) {
        prs.push({
          repo,
          number: pr.number,
          title: pr.title,
          author: pr.user?.login ?? null,
          state: pr.state,
          url: pr.html_url,
        });
      }
      if (resp.data.length < 100) break;
    }
  } else {
    // An author filter runs server-side through search (with a `repo:`
    // qualifier when scoped): filtering one REST page client-side missed every
    // matching PR beyond the newest 100.
    const q = [
      "is:pr",
      state === "all" ? "" : `is:${state}`,
      parts ? `repo:${parts.owner}/${parts.name}` : "",
      author ? `author:${author}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    for (let page = 1; ; page++) {
      const resp = await resolved.client.search.issuesAndPullRequests({
        q,
        per_page: 100,
        page,
        sort: "created",
        order: "asc",
      });
      if (resp.data.incomplete_results || (resp.data.total_count ?? 0) > 1000) {
        throw new ElizaError(
          "GitHub search cannot return a complete PR list; narrow the search and retry",
          { code: "GITHUB_PR_LIST_INCOMPLETE" },
        );
      }
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
      if (
        resp.data.items.length < 100 ||
        prs.length === resp.data.total_count
      ) {
        if (
          resp.data.total_count !== undefined &&
          prs.length !== resp.data.total_count
        ) {
          throw new ElizaError(
            "GitHub search changed while reading pages; retry for a complete PR list",
            { code: "GITHUB_PR_LIST_INCOMPLETE" },
          );
        }
        break;
      }
      if (page === 10) {
        throw new ElizaError(
          "GitHub search reached its result limit; narrow the search and retry",
          { code: "GITHUB_PR_LIST_INCOMPLETE" },
        );
      }
    }
  }

  await callback?.({ text: `Found ${prs.length} pull request(s)` });
  return { success: true, data: { op: "list", prs } };
}

async function runReview(
  runtime: IAgentRuntime,
  message: Memory,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubPrOpResult>> {
  const selection = resolveAccountSelection(options, "user");
  const repo = requireString(options, "repo");
  const number = requireNumber(options, "number");
  const action = parseReviewAction(options?.review_action);
  const body = requireString(options, "body");

  if (!repo || !number || !action) {
    const err =
      "GITHUB_PR_OP review requires repo (owner/name), number (integer), and review_action (approve|request-changes|comment)";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const parts = splitRepo(repo);
  if (!parts) {
    const err = `Invalid repo "${repo}" — expected "owner/name"`;
    await callback?.({ text: err });
    return { success: false, error: err };
  }

  // Reject what the review cannot run with before asking: a confirmation the
  // user answers must not be followed by an argument or account error.
  // GitHub requires a body for both REQUEST_CHANGES and COMMENT reviews.
  if (action !== "approve" && !body) {
    const err =
      action === "request-changes"
        ? "request-changes review requires a body explaining the changes"
        : "comment review requires a body";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resolved = await buildResolvedClient(runtime, selection);
  if ("error" in resolved) {
    await callback?.({ text: resolved.error });
    return { success: false, error: resolved.error };
  }

  const preview = buildReviewPreview(
    action,
    repo,
    number,
    body,
    describeSelection(selection),
  );
  const decision = await confirmPreviewedRequest({
    runtime,
    message,
    actionName: GitHubActions.GITHUB_PR_OP,
    pendingKey: `review:${repo}:${number}:${action}`,
    prompt: `${preview} Reply yes to confirm or no to cancel.`,
    callback,
    request: { repo, number, action, body, selection },
  });
  if (decision === "pending") {
    const text = `${preview} Reply yes to confirm or no to cancel.`;
    // requireConfirmation already delivered the pending prompt exactly once.
    return {
      success: true,
      text,
      data: { requiresConfirmation: true, preview, awaitingUserInput: true },
    };
  }
  if (decision === "cancelled") {
    const text = "GitHub PR review cancelled.";
    await callback?.({ text });
    return { success: true, text, data: { cancelled: true } };
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
    "Single router for GitHub PR ops: list and review. Review asks the user to reply yes before it is submitted.",
  descriptionCompressed:
    "GitHub PR ops: list pull requests, submit review with confirmation.",
  parameters: [
    {
      name: "subaction",
      description: "PR operation: list or review.",
      required: true,
      schema: { type: "string", enum: [...SUPPORTED_OPS] },
    },
    {
      name: "repo",
      description:
        "Repository in owner/name form. list requires repo or author.",
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
      description:
        "PR author login filter for list; @me means the token's own account. list requires repo or author.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "review_action",
      description: "Review action: approve, request-changes, or comment.",
      required: false,
      schema: {
        type: "string",
        enum: ["approve", "request-changes", "comment"],
      },
    },
    {
      name: "body",
      description:
        "Review body. Required for review_action comment and request-changes; optional for approve.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "as",
      description:
        "Identity to use: agent or user. When omitted, list runs as agent and review runs as user.",
      required: false,
      schema: { type: "string", enum: ["agent", "user"] },
    },
    {
      name: "accountId",
      description:
        "Optional GitHub account id from GITHUB_ACCOUNTS. Defaults by role.",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const r = await buildResolvedClient(runtime, "agent", {
      refresh: "on-miss",
    });
    return !("error" in r);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
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
        : await runReview(runtime, message, options, callback);
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
