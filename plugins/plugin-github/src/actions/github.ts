import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

import { issueOpAction } from "./issue-op.js";
import { notificationTriageAction } from "./notification-triage.js";
import { prOpAction } from "./pr-op.js";

const GITHUB_ACTIONS = [
  "pr_list",
  "pr_review",
  "issue_create",
  "issue_assign",
  "issue_close",
  "issue_reopen",
  "issue_comment",
  "issue_label",
  "notification_triage",
] as const;

type GitHubActionName = (typeof GITHUB_ACTIONS)[number];

const ISSUE_OP_BY_ACTION: Partial<Record<GitHubActionName, string>> = {
  issue_create: "create",
  issue_assign: "assign",
  issue_close: "close",
  issue_reopen: "reopen",
  issue_comment: "comment",
  issue_label: "label",
};

function readParameters(options: unknown): Record<string, unknown> {
  if (!options || typeof options !== "object") return {};
  const record = options as Record<string, unknown>;
  const params = record.parameters;
  return params && typeof params === "object" && !Array.isArray(params)
    ? { ...(params as Record<string, unknown>) }
    : { ...record };
}

function readAction(options: unknown): GitHubActionName | undefined {
  const params = readParameters(options);
  const raw =
    params.action ?? params.subaction ?? params.op ?? params.operation ?? params.verb;
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return (GITHUB_ACTIONS as readonly string[]).includes(normalized)
    ? (normalized as GitHubActionName)
    : undefined;
}

function withParameters(
  options: unknown,
  parameters: Record<string, unknown>,
): { parameters: Record<string, unknown> } & Record<string, unknown> {
  if (!options || typeof options !== "object") return { parameters };
  return { ...(options as Record<string, unknown>), parameters };
}

function delegate(
  target: Action,
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  return target.handler(
    runtime,
    message,
    state,
    options as HandlerOptions | undefined,
    callback,
  ) as Promise<ActionResult>;
}

export const githubAction: Action = {
  name: "GITHUB",
  contexts: ["code", "tasks", "connectors", "automation"],
  contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },
  similes: [
    "GITHUB_PR_OP",
    "GITHUB_ISSUE_OP",
    "GITHUB_NOTIFICATION_TRIAGE",
    "GITHUB_PULL_REQUEST",
    "GITHUB_ISSUE",
    "GITHUB_NOTIFICATIONS",
  ],
  description:
    "GitHub umbrella for pull requests, issues, and notification triage. Use action=pr_list/pr_review/issue_create/issue_assign/issue_close/issue_reopen/issue_comment/issue_label/notification_triage.",
  descriptionCompressed:
    "GitHub: pr_list|pr_review|issue_create|issue_assign|issue_close|issue_reopen|issue_comment|issue_label|notification_triage",
  parameters: [
    {
      name: "action",
      description: "GitHub operation to run.",
      required: true,
      schema: { type: "string", enum: [...GITHUB_ACTIONS] },
    },
    {
      name: "repo",
      description: "Repository in owner/name form.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "number",
      description: "Pull request or issue number.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "state",
      description: "PR state for pr_list: open, closed, or all.",
      required: false,
      schema: { type: "string", enum: ["open", "closed", "all"], default: "open" },
    },
    {
      name: "author",
      description: "Optional PR author username filter for pr_list.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "review_action",
      description: "For action=pr_review: approve, request-changes, or comment.",
      required: false,
      schema: { type: "string", enum: ["approve", "request-changes", "comment"] },
    },
    {
      name: "title",
      description: "Issue title for action=issue_create.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "body",
      description: "Issue body, issue comment body, or PR review body.",
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
      description: "Labels to apply on issue create or issue_label.",
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
      description: "Optional GitHub account id from GITHUB_ACCOUNTS. Defaults by role.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "confirmed",
      description: "Must be true for GitHub write operations.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (runtime, message, state) =>
    (await prOpAction.validate(runtime, message, state)) ||
    (await issueOpAction.validate(runtime, message, state)) ||
    (await notificationTriageAction.validate(runtime, message, state)),
  handler: async (runtime, message, state, options, callback) => {
    const action = readAction(options);
    const params = readParameters(options);
    if (!action) {
      return {
        success: false,
        text: "GITHUB requires action=pr_list/pr_review/issue_create/issue_assign/issue_close/issue_reopen/issue_comment/issue_label/notification_triage.",
        data: { error: "MISSING_ACTION" },
      };
    }
    if (action === "notification_triage") {
      return delegate(
        notificationTriageAction,
        runtime,
        message,
        state,
        withParameters(options, params),
        callback,
      );
    }
    if (action === "pr_list" || action === "pr_review") {
      const childParams = {
        ...params,
        op: action === "pr_list" ? "list" : "review",
        ...(action === "pr_review" && params.review_action
          ? { action: params.review_action }
          : {}),
      };
      return delegate(
        prOpAction,
        runtime,
        message,
        state,
        withParameters(options, childParams),
        callback,
      );
    }
    const issueOp = ISSUE_OP_BY_ACTION[action];
    if (issueOp) {
      return delegate(
        issueOpAction,
        runtime,
        message,
        state,
        withParameters(options, { ...params, op: issueOp }),
        callback,
      );
    }
    return {
      success: false,
      text: `Unsupported GITHUB action: ${action}`,
      data: { error: "UNSUPPORTED_ACTION", action },
    };
  },
};
