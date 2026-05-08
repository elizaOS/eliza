import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { hasLinearAccountConfig } from "../accounts";
import { linearAccountIdParameter } from "./account-options";
import { clearActivityAction } from "./clearActivity";
import { createCommentAction } from "./createComment";
import { createIssueAction } from "./createIssue";
import { deleteCommentAction } from "./deleteComment";
import { deleteIssueAction } from "./deleteIssue";
import { getActivityAction } from "./getActivity";
import { getIssueAction } from "./getIssue";
import { listCommentsAction } from "./listComments";
import { searchIssuesAction } from "./searchIssues";
import { handleUpdateComment } from "./updateComment";
import { handleUpdateIssue } from "./updateIssue";

export const LINEAR_CONTEXT = "linear";

type LinearOp =
  | "create_issue"
  | "get_issue"
  | "update_issue"
  | "delete_issue"
  | "create_comment"
  | "update_comment"
  | "delete_comment"
  | "list_comments"
  | "get_activity"
  | "clear_activity"
  | "search_issues";

const ALL_OPS: readonly LinearOp[] = [
  "create_issue",
  "get_issue",
  "update_issue",
  "delete_issue",
  "create_comment",
  "update_comment",
  "delete_comment",
  "list_comments",
  "get_activity",
  "clear_activity",
  "search_issues",
] as const;

type LinearHandlerFn = (
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  options?: HandlerOptions,
  callback?: HandlerCallback
) => Promise<ActionResult>;

interface LinearRoute {
  op: LinearOp;
  action?: Action;
  run?: LinearHandlerFn;
  match: RegExp;
}

const ROUTES: LinearRoute[] = [
  {
    op: "delete_issue",
    action: deleteIssueAction,
    match: /\b(delete|archive|remove|close)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
  {
    op: "update_issue",
    run: handleUpdateIssue,
    match:
      /\b(update|edit|modify|move|change|assign|reassign|priority|status|label)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
  {
    op: "create_issue",
    action: createIssueAction,
    match:
      /\b(create|new|add|file|open)\b.*\b(issue|bug|task|ticket|linear)\b|\b(issue|bug|task|ticket)\b.*\b(create|new|add|file|open)\b/i,
  },
  {
    op: "create_comment",
    action: createCommentAction,
    match: /\b(comment|reply|note|tell)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
  {
    op: "update_comment",
    run: handleUpdateComment,
    match: /\b(update|edit|modify|change)\b.*\bcomment\b/i,
  },
  {
    op: "delete_comment",
    action: deleteCommentAction,
    match: /\b(delete|remove|erase)\b.*\bcomment\b/i,
  },
  {
    op: "list_comments",
    action: listCommentsAction,
    match:
      /\b(list|show|get|fetch|view)\b.*\bcomments?\b|\bcomments?\b.*\b(list|show|get|fetch)\b/i,
  },
  {
    op: "clear_activity",
    action: clearActivityAction,
    match: /\b(clear|reset|delete)\b.*\b(activity|activity log)\b/i,
  },
  {
    op: "get_activity",
    action: getActivityAction,
    match: /\b(activity|activity log|what happened|recent changes|audit)\b/i,
  },
  {
    op: "search_issues",
    action: searchIssuesAction,
    match:
      /\b(search|find|query|list|show)\b.*\b(issues?|bugs?|tasks?|tickets?)\b|\b(open|closed|unassigned|assigned|high priority|blockers?)\b.*\b(issues?|bugs?|tasks?|tickets?)\b/i,
  },
  {
    op: "get_issue",
    action: getIssueAction,
    match:
      /\b(show|get|view|check|details?|status|what'?s|find)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b|[a-z]+-\d+/i,
  },
];

const LINEAR_FALLBACK_PATTERN =
  /\b(linear|issue|bug|task|ticket|comment|reply|activity|search|[a-z]+-\d+)\b/i;

function textOf(message: Memory): string {
  return typeof message.content?.text === "string" ? message.content.text : "";
}

function readOptions(options?: HandlerOptions | Record<string, unknown>): Record<string, unknown> {
  const direct = (options ?? {}) as Record<string, unknown>;
  const parameters =
    direct.parameters && typeof direct.parameters === "object"
      ? (direct.parameters as Record<string, unknown>)
      : {};
  return { ...direct, ...parameters };
}

function normalizeOp(value: unknown): LinearOp | null {
  if (typeof value !== "string") return null;
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (ALL_OPS as readonly string[]).includes(trimmed) ? (trimmed as LinearOp) : null;
}

function selectRoute(
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): LinearRoute | null {
  const opts = readOptions(options);
  const requested = normalizeOp(opts.op ?? opts.subaction);
  if (requested) {
    const route = ROUTES.find((candidate) => candidate.op === requested);
    if (route) return route;
  }
  const text = textOf(message);
  return ROUTES.find((route) => route.match.test(text)) ?? null;
}

function hasLinearAccess(runtime: IAgentRuntime): boolean {
  return hasLinearAccountConfig(runtime);
}

export const linearAction: Action = {
  name: "LINEAR",
  description:
    "Manage Linear issues, comments, and activity. Operations: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. The op is inferred from the message text when not explicitly provided.",
  descriptionCompressed:
    "Linear: create/get/update/delete issue, create/update/delete/list comment, search issues, get/clear activity.",
  similes: [
    // Group/router-style names
    "LINEAR_ISSUE",
    "LINEAR_ISSUES",
    "LINEAR_COMMENT",
    "LINEAR_COMMENTS",
    "LINEAR_WORKFLOW",
    "LINEAR_ACTIVITY",
    "LINEAR_SEARCH",
    // Issue ops
    "CREATE_LINEAR_ISSUE",
    "GET_LINEAR_ISSUE",
    "UPDATE_LINEAR_ISSUE",
    "DELETE_LINEAR_ISSUE",
    "MANAGE_LINEAR_ISSUE",
    "MANAGE_LINEAR_ISSUES",
    // Comment ops
    "CREATE_LINEAR_COMMENT",
    "COMMENT_LINEAR_ISSUE",
    "UPDATE_LINEAR_COMMENT",
    "DELETE_LINEAR_COMMENT",
    "LIST_LINEAR_COMMENTS",
    // Workflow / activity / search ops
    "GET_LINEAR_ACTIVITY",
    "CLEAR_LINEAR_ACTIVITY",
    "SEARCH_LINEAR_ISSUES",
    "LINEAR_WORKFLOW_SEARCH",
  ],
  contexts: ["general", "automation", "knowledge", LINEAR_CONTEXT],
  contextGate: { anyOf: ["general", "automation", "knowledge", LINEAR_CONTEXT] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "op",
      description:
        "Operation to perform. One of: create_issue, get_issue, update_issue, delete_issue, create_comment, update_comment, delete_comment, list_comments, get_activity, clear_activity, search_issues. Inferred from message text when omitted.",
      required: false,
      schema: { type: "string", enum: [...ALL_OPS] },
    },
    linearAccountIdParameter,
  ],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    if (!hasLinearAccess(runtime)) return false;
    const text = textOf(message);
    if (!text.trim()) return false;
    return ROUTES.some((route) => route.match.test(text)) || LINEAR_FALLBACK_PATTERN.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const route = selectRoute(message, options);
    if (!route) {
      const ops = ALL_OPS.join(", ");
      const text = `LINEAR could not determine the operation. Specify one of: ${ops}.`;
      await callback?.({ text, source: message.content?.source });
      return {
        success: false,
        text,
        values: { error: "MISSING" },
        data: { actionName: "LINEAR", availableOps: ops },
      };
    }

    const dispatch = route.run ?? route.action?.handler?.bind(route.action);
    const result = dispatch
      ? ((await dispatch(runtime, message, state, options, callback)) ??
        ({ success: true } as ActionResult))
      : ({ success: true } as ActionResult);
    return {
      ...result,
      data: {
        ...(typeof result.data === "object" && result.data ? result.data : {}),
        actionName: "LINEAR",
        routedActionName: route.action?.name ?? route.op,
        op: route.op,
      },
    };
  },
  examples: [
    [
      { name: "{{user1}}", content: { text: "Create a Linear issue for the mobile login bug" } },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create that Linear issue.",
          actions: ["LINEAR"],
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Comment on ENG-123 that QA can retest it" } },
      {
        name: "{{agentName}}",
        content: { text: "I'll add that comment to ENG-123.", actions: ["LINEAR"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Search open Linear bugs for the backend team" } },
      {
        name: "{{agentName}}",
        content: { text: "I'll search Linear issues.", actions: ["LINEAR"] },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "What's the status of ENG-456?" } },
      {
        name: "{{agentName}}",
        content: { text: "Looking up ENG-456.", actions: ["LINEAR"] },
      },
    ],
  ],
};
