/**
 * @module issue-op
 * @description Single router action covering GitHub issue lifecycle ops:
 * create, assign, close, reopen, comment, label. Replaces the old
 * CREATE_ISSUE / ASSIGN_ISSUE actions and absorbs the issue-management ops
 * previously implemented in plugin-agent-orchestrator's MANAGE_ISSUES.
 *
 * All ops are write ops gated on `confirmed: true`.
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
  optionalStringArray,
  type ResolvedClient,
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
  | { op: "create"; number: number; url: string }
  | { op: "assign"; number: number; assignees: string[] }
  | { op: "close"; number: number; title: string }
  | { op: "reopen"; number: number; title: string }
  | { op: "comment"; number: number; commentId: number; url: string }
  | { op: "label"; number: number; labels: string[] };

async function runCreate(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  const title = requireString(options, "title");
  const body = requireString(options, "body");
  const labels = optionalStringArray(options, "labels");
  const assignees = optionalStringArray(options, "assignees");
  if (!title) {
    const err = "GITHUB_ISSUE_OP create requires title";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resp = await resolved.client.issues.create({
    owner: parts.owner,
    repo: parts.name,
    title,
    body: body ?? undefined,
    labels,
    assignees,
  });
  await callback?.({
    text: `Created issue ${repo}#${resp.data.number}: ${resp.data.html_url}`,
  });
  return {
    success: true,
    data: {
      op: "create",
      number: resp.data.number,
      url: resp.data.html_url,
    },
  };
}

async function runAssign(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  const number = requireNumber(options, "number");
  const assignees = requireStringArray(options, "assignees");
  if (!number || !assignees || assignees.length === 0) {
    const err =
      "GITHUB_ISSUE_OP assign requires number (integer) and assignees (non-empty string[])";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resp = await resolved.client.issues.addAssignees({
    owner: parts.owner,
    repo: parts.name,
    issue_number: number,
    assignees,
  });
  const actual = (resp.data.assignees ?? [])
    .map((a) => a?.login)
    .filter((x): x is string => typeof x === "string");
  await callback?.({
    text: `Assigned [${actual.join(", ")}] to ${repo}#${number}`,
  });
  return {
    success: true,
    data: { op: "assign", number, assignees: actual },
  };
}

async function runStateChange(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
  target: "closed" | "open",
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  const number = requireNumber(options, "number");
  if (!number) {
    const err = `GITHUB_ISSUE_OP ${target === "closed" ? "close" : "reopen"} requires number (integer)`;
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resp = await resolved.client.issues.update({
    owner: parts.owner,
    repo: parts.name,
    issue_number: number,
    state: target,
  });
  const verb = target === "closed" ? "Closed" : "Reopened";
  await callback?.({ text: `${verb} ${repo}#${number}: ${resp.data.title}` });
  return {
    success: true,
    data: {
      op: target === "closed" ? "close" : "reopen",
      number,
      title: resp.data.title,
    },
  };
}

async function runComment(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  const number = requireNumber(options, "number");
  const body = requireString(options, "body");
  if (!number || !body) {
    const err = "GITHUB_ISSUE_OP comment requires number (integer) and body";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resp = await resolved.client.issues.createComment({
    owner: parts.owner,
    repo: parts.name,
    issue_number: number,
    body,
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

async function runLabel(
  resolved: ResolvedClient,
  parts: RepoParts,
  repo: string,
  options: Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined,
): Promise<GitHubActionResult<GitHubIssueOpResult>> {
  const number = requireNumber(options, "number");
  const labels = requireStringArray(options, "labels");
  if (!number || !labels || labels.length === 0) {
    const err =
      "GITHUB_ISSUE_OP label requires number (integer) and labels (non-empty string[])";
    await callback?.({ text: err });
    return { success: false, error: err };
  }
  const resp = await resolved.client.issues.addLabels({
    owner: parts.owner,
    repo: parts.name,
    issue_number: number,
    labels,
  });
  const applied = (resp.data ?? [])
    .map((label) => (typeof label === "string" ? label : (label?.name ?? null)))
    .filter((x): x is string => typeof x === "string");
  await callback?.({
    text: `Applied labels [${applied.join(", ")}] to ${repo}#${number}`,
  });
  return {
    success: true,
    data: { op: "label", number, labels: applied },
  };
}

function buildPreview(
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
        return ` issue: "${title ?? "(no title)"}"${labels ? ` [labels: ${labels.join(", ")}]` : ""}${assignees ? ` [assignees: ${assignees.join(", ")}]` : ""}`;
      case "assign":
        return ` with [${assignees?.join(", ") ?? ""}]`;
      case "label":
        return ` with [${labels?.join(", ") ?? ""}]`;
      case "comment":
        return body ? ` body: "${body.slice(0, 120)}"` : "";
      default:
        return "";
    }
  })();
  return `${head}${target}${detail} as ${identity}. Re-invoke with confirmed: true to proceed.`;
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
    "Single router for GitHub issue ops: create, assign, close, reopen, comment, label. Requires confirmed:true.",
  descriptionCompressed:
    "GitHub issue ops: create, assign, close, reopen, comment, label.",
  parameters: [
    {
      name: "op",
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
      name: "confirmed",
      description: "Must be true to perform the write operation.",
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
  ): Promise<GitHubActionResult<GitHubIssueOpResult>> => {
    const op = parseOp(options?.op);
    if (!op) {
      const err =
        "GITHUB_ISSUE_OP requires op (create|assign|close|reopen|comment|label)";
      await callback?.({ text: err });
      return { success: false, error: err };
    }

    const identity = resolveIdentity(options, "agent");
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

    if (!isConfirmed(options)) {
      const preview = buildPreview(op, repo, identity, options);
      await callback?.({ text: preview });
      return { success: false, requiresConfirmation: true, preview };
    }

    const resolved = buildResolvedClient(runtime, identity);
    if ("error" in resolved) {
      await callback?.({ text: resolved.error });
      return { success: false, error: resolved.error };
    }

    try {
      switch (op) {
        case "create":
          return await runCreate(resolved, parts, repo, options, callback);
        case "assign":
          return await runAssign(resolved, parts, repo, options, callback);
        case "close":
          return await runStateChange(
            resolved,
            parts,
            repo,
            options,
            callback,
            "closed",
          );
        case "reopen":
          return await runStateChange(
            resolved,
            parts,
            repo,
            options,
            callback,
            "open",
          );
        case "comment":
          return await runComment(resolved, parts, repo, options, callback);
        case "label":
          return await runLabel(resolved, parts, repo, options, callback);
      }
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
