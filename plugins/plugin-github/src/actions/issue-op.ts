/**
 * Single router action covering the GitHub issue lifecycle ops: create,
 * assign, close, reopen, comment, label. Dispatched to by the umbrella
 * GITHUB action. Every op is a write op and passes through the runtime's
 * `requireConfirmation` gate before it touches the GitHub API.
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger, toWellFormedUnicode } from "@elizaos/core";
import {
  buildResolvedClient,
  confirmPreviewedRequest,
  describeSelection,
  optionalStringArray,
  type ResolvedClient,
  requireNumber,
  requireString,
  requireStringArray,
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
  type GitHubIssueOp,
} from "../types.js";

const SUPPORTED_OPS: ReadonlySet<GitHubIssueOp> = new Set([
  "create",
  "assign",
  "close",
  "reopen",
  "comment",
  "label",
]);

function parseOp(value: unknown): GitHubIssueOp | null {
  if (typeof value !== "string") return null;
  return SUPPORTED_OPS.has(value as GitHubIssueOp)
    ? (value as GitHubIssueOp)
    : null;
}

function describeOp(op: GitHubIssueOp): string {
  switch (op) {
    case "create":
      return "create";
    case "assign":
      return "assign";
    case "close":
      return "close";
    case "reopen":
      return "reopen";
    case "comment":
      return "comment on";
    case "label":
      return "label";
  }
}

interface RepoParts {
  owner: string;
  name: string;
}

/**
 * Result payloads keyed by op, kept loose so callers can route on `op` and
 * narrow the data. Individual op helpers return the payload directly; the
 * router wraps it in `{ success: true, data }` and emits a callback message.
 */
export type GitHubIssueOpResult =
  | {
      op: "create";
      number: number;
      url: string;
      /** Requested labels or assignees GitHub did not apply. */
      notApplied?: { labels: string[]; assignees: string[] };
    }
  | { op: "assign"; number: number; assignees: string[] }
  | { op: "close"; number: number; title: string }
  | { op: "reopen"; number: number; title: string }
  | { op: "comment"; number: number; commentId: number; url: string }
  | { op: "label"; number: number; labels: string[] }
  | { requiresConfirmation: true; preview: string; awaitingUserInput: true }
  | { cancelled: true };

/** One issue op with the fields that op cannot run without. */
type IssueRequest =
  | {
      op: "create";
      title: string;
      body: string | null;
      labels: string[] | undefined;
      assignees: string[] | undefined;
    }
  | { op: "assign"; number: number; assignees: string[] }
  | { op: "close" | "reopen"; number: number }
  | { op: "comment"; number: number; body: string }
  | { op: "label"; number: number; labels: string[] };

/**
 * Read the fields the op requires. The handler runs this before the
 * confirmation prompt, so a call that cannot run never asks the user to
 * confirm it.
 */
function parseRequest(
  op: GitHubIssueOp,
  options: Record<string, unknown> | undefined,
): IssueRequest | { error: string } {
  const number = requireNumber(options, "number");
  switch (op) {
    case "create": {
      const title = requireString(options, "title");
      if (!title) return { error: "GITHUB_ISSUE_OP create requires title" };
      return {
        op,
        title,
        body: requireString(options, "body"),
        labels: optionalStringArray(options, "labels"),
        assignees: optionalStringArray(options, "assignees"),
      };
    }
    case "assign": {
      const assignees = requireStringArray(options, "assignees");
      if (!number || !assignees || assignees.length === 0) {
        return {
          error:
            "GITHUB_ISSUE_OP assign requires number (integer) and assignees (non-empty string[])",
        };
      }
      return { op, number, assignees };
    }
    case "close":
    case "reopen":
      if (!number) {
        return { error: `GITHUB_ISSUE_OP ${op} requires number (integer)` };
      }
      return { op, number };
    case "comment": {
      const body = requireString(options, "body");
      if (!number || !body) {
        return {
          error: "GITHUB_ISSUE_OP comment requires number (integer) and body",
        };
      }
      return { op, number, body };
    }
    case "label": {
      const labels = requireStringArray(options, "labels");
      if (!number || !labels || labels.length === 0) {
        return {
          error:
            "GITHUB_ISSUE_OP label requires number (integer) and labels (non-empty string[])",
        };
      }
      return { op, number, labels };
    }
  }
}

/**
 * Requested names missing from GitHub's response. GitHub returns success and
 * silently ignores labels and assignees the caller may not set.
 */
function missingNames(
  requested: readonly string[] | undefined,
  applied: ReadonlyArray<
    string | { name?: string | null; login?: string | null } | null
  >,
): string[] {
  const present = new Set(
    applied
      .map((item) =>
        typeof item === "string" ? item : (item?.login ?? item?.name),
      )
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase()),
  );
  return (requested ?? []).filter((name) => !present.has(name.toLowerCase()));
}

async function runRequest(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  request: IssueRequest,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  switch (request.op) {
    case "create": {
      const resp = await resolved.client.issues.create({
        owner: parts.owner,
        repo: parts.name,
        title: request.title,
        body: request.body ?? undefined,
        labels: request.labels,
        assignees: request.assignees,
      });
      const labels = missingNames(request.labels, resp.data.labels ?? []);
      const assignees = missingNames(
        request.assignees,
        resp.data.assignees ?? [],
      );
      const notApplied =
        labels.length > 0 || assignees.length > 0
          ? { labels, assignees }
          : undefined;
      const skipped = notApplied
        ? ` GitHub did not apply ${[
            labels.length > 0 ? `labels [${labels.join(", ")}]` : "",
            assignees.length > 0 ? `assignees [${assignees.join(", ")}]` : "",
          ]
            .filter(Boolean)
            .join(" or ")}; this account may lack push access.`
        : "";
      await callback?.({
        text: `Created issue ${repo}#${resp.data.number}: ${resp.data.html_url}${skipped}`,
      });
      return {
        success: true,
        data: {
          op: "create",
          number: resp.data.number,
          url: resp.data.html_url,
          ...(notApplied ? { notApplied } : {}),
        },
      };
    }
    case "assign": {
      const { number } = request;
      const resp = await resolved.client.issues.addAssignees({
        owner: parts.owner,
        repo: parts.name,
        issue_number: number,
        assignees: request.assignees,
      });
      const actual = (resp.data.assignees ?? [])
        .map((a) => a?.login)
        .filter((x): x is string => typeof x === "string");
      const notAssigned = missingNames(request.assignees, actual);
      if (notAssigned.length > 0) {
        const error = `GitHub did not assign [${notAssigned.join(", ")}] to ${repo}#${number}; this account may lack push access, or they cannot be assigned. Current assignees: [${actual.join(", ")}]`;
        await callback?.({ text: error });
        return { success: false, error };
      }
      await callback?.({
        text: `Assigned [${actual.join(", ")}] to ${repo}#${number}`,
      });
      return {
        success: true,
        data: { op: "assign", number, assignees: actual },
      };
    }
    case "close":
    case "reopen": {
      const { op, number } = request;
      const resp = await resolved.client.issues.update({
        owner: parts.owner,
        repo: parts.name,
        issue_number: number,
        state: op === "close" ? "closed" : "open",
      });
      const verb = op === "close" ? "Closed" : "Reopened";
      await callback?.({
        text: `${verb} ${repo}#${number}: ${resp.data.title}`,
      });
      return {
        success: true,
        data: { op, number, title: resp.data.title },
      };
    }
    case "comment": {
      const { number } = request;
      const resp = await resolved.client.issues.createComment({
        owner: parts.owner,
        repo: parts.name,
        issue_number: number,
        body: request.body,
      });
      await callback?.({
        text: `Commented on ${repo}#${number}: ${resp.data.html_url}`,
      });
      return {
        success: true,
        data: {
          op: "comment",
          number,
          commentId: resp.data.id,
          url: resp.data.html_url,
        },
      };
    }
    case "label": {
      const { number } = request;
      const resp = await resolved.client.issues.addLabels({
        owner: parts.owner,
        repo: parts.name,
        issue_number: number,
        labels: request.labels,
      });
      const applied = (resp.data ?? [])
        .map((label) =>
          typeof label === "string" ? label : (label?.name ?? null),
        )
        .filter((x): x is string => typeof x === "string");
      await callback?.({
        text: `Applied labels [${applied.join(", ")}] to ${repo}#${number}`,
      });
      return {
        success: true,
        data: { op: "label", number, labels: applied },
      };
    }
  }
}

export function buildPreview(
  op: GitHubIssueOp,
  repo: string,
  identity: string,
  options: Record<string, unknown> | undefined,
): string {
  const number = requireNumber(options, "number");
  const title = requireString(options, "title");
  const body = requireString(options, "body");
  const assignees = optionalStringArray(options, "assignees");
  const labels = optionalStringArray(options, "labels");
  const head = `About to ${describeOp(op)} ${repo}`;
  const target = number ? `#${number}` : "";
  const detail = (() => {
    switch (op) {
      case "create":
        return ` issue: "${title ?? "(no title)"}"${body ? ` body: "${toWellFormedUnicode(body)}"` : ""}${labels ? ` [labels: ${labels.join(", ")}]` : ""}${assignees ? ` [assignees: ${assignees.join(", ")}]` : ""}`;
      case "assign":
        return ` with [${assignees?.join(", ") ?? ""}]`;
      case "label":
        return ` with [${labels?.join(", ") ?? ""}]`;
      case "comment":
        return body ? ` body: "${toWellFormedUnicode(body)}"` : "";
      default:
        return "";
    }
  })();
  return `${head}${target}${detail} as ${identity}.`;
}

export const issueOpAction: Action = {
  name: GitHubActions.GITHUB_ISSUE_OP,
  contexts: ["code", "tasks", "connectors", "automation"],
  contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "CREATE_ISSUE",
    "OPEN_ISSUE",
    "FILE_ISSUE",
    "GITHUB_CREATE_ISSUE",
    "ASSIGN_ISSUE",
    "ASSIGN_GITHUB_ISSUE",
    "ADD_ASSIGNEE",
    "CLOSE_ISSUE",
    "REOPEN_ISSUE",
    "COMMENT_ISSUE",
    "ADD_ISSUE_COMMENT",
    "LABEL_ISSUE",
    "ADD_ISSUE_LABEL",
    "MANAGE_ISSUES",
  ],
  description:
    "Single router for GitHub issue ops: create, assign, close, reopen, comment, label. Each op asks the user to reply yes before it runs.",
  descriptionCompressed:
    "GitHub issue ops: create, assign, close, reopen, comment, label.",
  parameters: [
    {
      name: "subaction",
      description:
        "Issue operation: create, assign, close, reopen, comment, or label.",
      required: true,
      schema: { type: "string", enum: [...SUPPORTED_OPS] },
    },
    {
      name: "repo",
      description: "Repository in owner/name form.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "number",
      description: "Issue number for existing-issue operations.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "title",
      description: "Issue title for create.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "Issue body or comment body.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "assignees",
      description: "GitHub usernames to assign.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "labels",
      description: "Labels to apply on create or label.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "as",
      description: "Identity to use: agent or user.",
      required: false,
      schema: { type: "string", enum: ["agent", "user"], default: "agent" },
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
  ): Promise<GitHubActionResult<GitHubIssueOpResult>> => {
    const op = parseOp(options?.op);
    if (!op) {
      const err =
        "GITHUB_ISSUE_OP requires op (create|assign|close|reopen|comment|label)";
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    const selection = resolveAccountSelection(options, "agent");
    const repo = requireString(options, "repo");
    if (!repo) {
      const err = "GITHUB_ISSUE_OP requires repo (owner/name)";
      await callback?.({ text: err });
      return { success: false, error: err };
    }
    const parts = splitRepo(repo);
    if (!parts) {
      const err = `Invalid repo "${repo}" — expected "owner/name"`;
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    const request = parseRequest(op, options);
    if ("error" in request) {
      await callback?.({ text: request.error });
      return { success: false, error: request.error };
    }
    const resolved = await buildResolvedClient(runtime, selection);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    const preview = buildPreview(
      op,
      repo,
      describeSelection(selection),
      options,
    );
    const prompt = `${preview} Reply yes to confirm or no to cancel.`;
    // The pending key must identify the specific operation: without the
    // issue number, two pending confirmations in one repo share a key and
    // the second request is swallowed by the first one's confirmation turn.
    // Create has no number yet, so its title distinguishes it instead.
    const pendingKey =
      "number" in request
        ? `${op}:${repo}:${request.number}`
        : `${op}:${repo}:create:${request.title}`;
    const decision = await confirmPreviewedRequest({
      runtime,
      message,
      actionName: "GITHUB_ISSUE_OP",
      pendingKey,
      prompt,
      callback,
      request: { repo, request, selection },
    });
    if (decision === "pending") {
      return {
        success: false,
        requiresConfirmation: true,
        preview,
        // Mirror the delivered prompt and the pending-interaction markers so
        // the planner terminal path grounds on the tool-owned text instead of
        // appending its generic failed-tool fallback after the visible prompt.
        text: prompt,
        data: { requiresConfirmation: true, preview, awaitingUserInput: true },
      };
    }
    if (decision === "cancelled") {
      const cancelMessage = "GitHub issue operation cancelled.";
      await callback?.({ text: cancelMessage });
      return { success: false, error: cancelMessage };
    }

    try {
      return await runRequest(resolved, parts, repo, request, callback);
    } catch (err) {
      const rl = inspectRateLimit(err);
      const message = rl.isRateLimited
        ? formatRateLimitMessage(rl)
        : `GITHUB_ISSUE_OP ${op} failed: ${errorMessage(err)}`;
      logger.warn({ message }, "[GitHub:GITHUB_ISSUE_OP]");
      await callback?.({ text: message });
      return { success: false, error: message };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Open an issue in elizaOS/eliza titled 'Docs gap'",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Created issue elizaOS/eliza#101",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Close issue elizaOS/eliza#42",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Closed elizaOS/eliza#42",
        },
      },
    ],
  ],
};
