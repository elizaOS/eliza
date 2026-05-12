import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  ProviderValue,
  State,
} from "@elizaos/core";
import { hasLinearAccountConfig } from "../accounts";
import { linearAccountIdParameter } from "./account-options";
import { clearActivityAction } from "./clearActivity";
import { createCommentAction } from "./createComment";
import { createIssueAction } from "./createIssue";
import { deleteIssueAction } from "./deleteIssue";
import { getActivityAction } from "./getActivity";
import { getIssueAction } from "./getIssue";
import { searchIssuesAction } from "./searchIssues";
import { updateIssueAction } from "./updateIssue";

export const LINEAR_ISSUE_CONTEXT = "linear_issue";
export const LINEAR_COMMENT_CONTEXT = "linear_comment";
export const LINEAR_WORKFLOW_CONTEXT = "linear_workflow";

/**
 * Common envelope every Linear router result carries. `actionName` and
 * `router` identify the public router action that produced the result,
 * `routedActionName` names the child action that handled the request, and
 * `op`/`subaction` are the resolved verb (or `null` when no route matched).
 * `result` carries child action data on success and `error` carries structured
 * failure details. The index signature is required so the result is assignable
 * to `ProviderDataRecord`.
 */
interface LinearRouterEnvelope {
  router: string;
  routedActionName: string | null;
  op: string | null;
  subaction: string | null;
  result?: ProviderValue;
  error?: ProviderValue;
  /** List of valid subactions, populated only on missing-subaction errors. */
  availableSubactions?: string;
  [key: string]: ProviderValue;
}

interface LinearIssueSummary {
  id: string;
  identifier: string;
  title: string;
}

/**
 * `LINEAR_ISSUE` router result. Fields below are the union of what
 * createIssue/getIssue/updateIssue/deleteIssue place in `data`. Each is
 * optional because only the routed child populates its subset.
 */
export interface LinearIssueRouterResultData extends LinearRouterEnvelope {
  actionName: "LINEAR_ISSUE";
  /** createIssue, updateIssue, deleteIssue (also prompt branches). */
  issueId?: string;
  /** createIssue, updateIssue, deleteIssue. */
  identifier?: string;
  /** createIssue, updateIssue. */
  url?: string;
  /** updateIssue: snapshot of fields that were changed. */
  updates?: Record<string, ProviderValue>;
  /** deleteIssue. */
  title?: string;
  archived?: boolean;
  /** deleteIssue (pending confirmation) and any future awaiting branches. */
  awaitingUserInput?: boolean;
  /** deleteIssue (user declined). */
  cancelled?: boolean;
  /** getIssue (single hit): full serialized issue details. */
  issue?: Record<string, ProviderValue>;
  /** getIssue (multi-result clarify branch). */
  multipleResults?: boolean;
  /** getIssue clarify branch: shortlist for the user to disambiguate. */
  issues?: LinearIssueSummary[];
}

/**
 * `LINEAR_COMMENT` router result. Sourced from createComment.
 */
export interface LinearCommentRouterResultData extends LinearRouterEnvelope {
  actionName: "LINEAR_COMMENT";
  /** createComment success. */
  commentId?: string;
  issueId?: string;
  issueIdentifier?: string;
  commentBody?: string;
  createdAt?: string;
  /** createComment clarify branch when multiple issues match. */
  multipleMatches?: boolean;
  issues?: LinearIssueSummary[];
  /** Comment text held while clarifying which issue to attach it to. */
  pendingComment?: string;
}

interface LinearActivityItem {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  success: boolean;
  error?: string;
  details: ProviderValue;
  timestamp: string;
}

interface LinearSearchIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number | null;
  state: { name: string; type: string } | null;
  assignee: { name: string; email: string } | null;
  team: { name: string; key: string } | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/**
 * `LINEAR_WORKFLOW` router result. Sourced from
 * getActivity/clearActivity/searchIssues.
 */
export interface LinearWorkflowRouterResultData extends LinearRouterEnvelope {
  actionName: "LINEAR_WORKFLOW";
  /** getActivity. */
  activity?: LinearActivityItem[];
  /** getActivity, searchIssues. */
  filters?: Record<string, ProviderValue>;
  count?: number;
  /** searchIssues. */
  issues?: LinearSearchIssue[];
  /** clearActivity (pending confirmation). */
  awaitingUserInput?: boolean;
  /** clearActivity (user declined). */
  cancelled?: boolean;
}

type LinearRouterResultData =
  | LinearIssueRouterResultData
  | LinearCommentRouterResultData
  | LinearWorkflowRouterResultData;

type RouterAction = Action & {
  actionGroup?: {
    contexts?: string[];
  };
};

type LinearRoute = {
  subaction: string;
  action: Action;
  match: RegExp;
};

const issueRoutes: LinearRoute[] = [
  {
    subaction: "delete",
    action: deleteIssueAction,
    match: /\b(delete|archive|remove|close)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
  {
    subaction: "update",
    action: updateIssueAction,
    match:
      /\b(update|edit|modify|move|change|assign|reassign|priority|status|label)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
  {
    subaction: "create",
    action: createIssueAction,
    match:
      /\b(create|new|add|file|open)\b.*\b(issue|bug|task|ticket|linear)\b|\b(issue|bug|task|ticket)\b.*\b(create|new|add|file|open)\b/i,
  },
  {
    subaction: "get",
    action: getIssueAction,
    match:
      /\b(show|get|view|check|details?|status|what'?s|find)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b|[a-z]+-\d+/i,
  },
];

const commentRoutes: LinearRoute[] = [
  {
    subaction: "create",
    action: createCommentAction,
    match: /\b(comment|reply|note|tell)\b.*\b(issue|bug|task|ticket|[a-z]+-\d+)\b/i,
  },
];

const workflowRoutes: LinearRoute[] = [
  {
    subaction: "clear_activity",
    action: clearActivityAction,
    match: /\b(clear|reset|delete)\b.*\b(activity|activity log)\b/i,
  },
  {
    subaction: "get_activity",
    action: getActivityAction,
    match: /\b(activity|activity log|what happened|recent changes|audit)\b/i,
  },
  {
    subaction: "search_issues",
    action: searchIssuesAction,
    match:
      /\b(search|find|query|list|show)\b.*\b(issues?|bugs?|tasks?|tickets?)\b|\b(open|closed|unassigned|assigned|high priority|blockers?)\b.*\b(issues?|bugs?|tasks?|tickets?)\b/i,
  },
];

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

function normalizeSubaction(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : null;
}

function selectRoute(
  routes: readonly LinearRoute[],
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): LinearRoute | null {
  const opts = readOptions(options);
  const requested = normalizeSubaction(opts.action ?? opts.subaction);
  if (requested) {
    const route = routes.find((candidate) => candidate.subaction === requested);
    if (route) return route;
  }

  const text = textOf(message);
  return routes.find((route) => route.match.test(text)) ?? null;
}

function hasLinearAccess(runtime: IAgentRuntime): boolean {
  return hasLinearAccountConfig(runtime);
}

function readErrorCode(result: ActionResult): string {
  const valuesError = result.values?.error;
  if (typeof valuesError === "string" && valuesError.length > 0) return valuesError;

  const dataError =
    typeof result.data === "object" && result.data !== null ? result.data.error : undefined;
  if (typeof dataError === "string" && dataError.length > 0) return dataError;

  return "ACTION_FAILED";
}

function readErrorMessage(result: ActionResult, fallbackText: string): string {
  if (result.error instanceof Error) return result.error.message;
  if (typeof result.error === "string" && result.error.length > 0) return result.error;
  return fallbackText;
}

async function validateRouter(
  runtime: IAgentRuntime,
  _message: Memory,
  _routes: readonly LinearRoute[],
  _fallback: RegExp
): Promise<boolean> {
  return hasLinearAccess(runtime);
}

async function dispatchRoute<T extends LinearRouterResultData>(
  routerName: T["actionName"],
  routes: readonly LinearRoute[],
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | Record<string, unknown> | undefined,
  callback: HandlerCallback | undefined
): Promise<ActionResult> {
  const route = selectRoute(routes, message, options);
  if (!route) {
    const subactions = routes.map((candidate) => candidate.subaction).join(", ");
    const text = `${routerName} requires one of these subactions: ${subactions}.`;
    await callback?.({ text, source: message.content?.source });
    const data: T = {
      actionName: routerName,
      router: routerName,
      routedActionName: null,
      op: null,
      subaction: null,
      error: {
        code: "MISSING_SUBACTION",
        message: text,
      },
      availableSubactions: subactions,
    } as T;
    return {
      success: false,
      text,
      values: { error: "MISSING_SUBACTION" },
      data,
    };
  }

  const result =
    (await route.action.handler(runtime, message, state, options as HandlerOptions, callback)) ??
    ({
      success: true,
      text: `${routerName} routed to ${route.action.name}.`,
      data: {},
    } as ActionResult);
  const text =
    typeof result.text === "string" && result.text.length > 0
      ? result.text
      : `${routerName} routed to ${route.action.name}.`;
  const success = result.success ?? true;
  const childData = typeof result.data === "object" && result.data !== null ? result.data : {};
  const data: T = {
    ...childData,
    actionName: routerName,
    router: routerName,
    routedActionName: route.action.name,
    op: route.subaction,
    subaction: route.subaction,
    ...(success
      ? { result: Object.keys(childData).length > 0 ? childData : { ok: true } }
      : {
          result: Object.keys(childData).length > 0 ? childData : undefined,
          error: {
            code: readErrorCode(result),
            message: readErrorMessage(result, text),
          },
        }),
  } as T;
  return {
    ...result,
    success,
    text,
    data,
  };
}

export function getLinearRouteForTest(
  group: "issue" | "comment" | "workflow",
  message: Memory,
  options?: HandlerOptions | Record<string, unknown>
): string | null {
  const routes =
    group === "issue" ? issueRoutes : group === "comment" ? commentRoutes : workflowRoutes;
  return selectRoute(routes, message, options)?.subaction ?? null;
}

/**
 * Routes natural-language issue intents to CREATE/GET/UPDATE/DELETE Linear
 * issue actions. `data` is `LinearIssueRouterResultData`: always carries
 * `actionName: "LINEAR_ISSUE"`, `routedActionName`, and `subaction`. Result
 * fields like `issueId`, `identifier`, and `url` are populated by the routed
 * child; absent fields just mean that child didn't supply them.
 */
export const linearIssueRouterAction: RouterAction = {
  name: "LINEAR_ISSUE",
  description: "Route Linear issue operations: create, get, update, or delete issues.",
  descriptionCompressed: "route Linear issue create get update delete",
  similes: [],
  contexts: ["general", "automation", "knowledge", LINEAR_ISSUE_CONTEXT],
  actionGroup: { contexts: [LINEAR_ISSUE_CONTEXT] },
  roleGate: { minRole: "USER" },
  validate: (runtime, message) =>
    validateRouter(runtime, message, issueRoutes, /\b(linear|issue|bug|task|ticket|[a-z]+-\d+)\b/i),
  handler: (runtime, message, state, options, callback) =>
    dispatchRoute<LinearIssueRouterResultData>(
      "LINEAR_ISSUE",
      issueRoutes,
      runtime,
      message,
      state,
      options,
      callback
    ),
  parameters: [
    {
      name: "action",
      description: "Issue operation to run.",
      required: false,
      schema: { type: "string", enum: ["create", "get", "update", "delete"] },
    },
    linearAccountIdParameter,
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Create a Linear issue for the mobile login bug" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create that Linear issue.",
          actions: ["LINEAR_ISSUE"],
        },
      },
    ],
  ],
};

/**
 * Routes Linear comment intents to the comment child actions. `data` is
 * `LinearCommentRouterResultData` with the standard envelope plus
 * `commentId`, `issueId`, `issueIdentifier`, `commentBody`, and `createdAt`
 * on success, or a `multipleMatches`/`pendingComment` clarify branch.
 */
export const linearCommentRouterAction: RouterAction = {
  name: "LINEAR_COMMENT",
  description: "Route Linear comment operations for issues.",
  descriptionCompressed: "route Linear issue comment create reply note",
  similes: [],
  contexts: ["general", "automation", LINEAR_COMMENT_CONTEXT],
  actionGroup: { contexts: [LINEAR_COMMENT_CONTEXT] },
  roleGate: { minRole: "USER" },
  validate: (runtime, message) =>
    validateRouter(runtime, message, commentRoutes, /\b(comment|reply|note|tell)\b/i),
  handler: (runtime, message, state, options, callback) =>
    dispatchRoute<LinearCommentRouterResultData>(
      "LINEAR_COMMENT",
      commentRoutes,
      runtime,
      message,
      state,
      options,
      callback
    ),
  parameters: [
    {
      name: "action",
      description: "Comment operation to run.",
      required: false,
      schema: { type: "string", enum: ["create"] },
    },
    linearAccountIdParameter,
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Comment on ENG-123 that QA can retest it" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll add that comment to ENG-123.",
          actions: ["LINEAR_COMMENT"],
        },
      },
    ],
  ],
};

/**
 * Routes Linear workflow intents to getActivity/clearActivity/searchIssues.
 * `data` is `LinearWorkflowRouterResultData`: standard envelope plus
 * `activity`/`filters`/`count` (activity), `issues`/`filters`/`count`
 * (search), or `awaitingUserInput`/`cancelled` (clearActivity).
 */
export const linearWorkflowRouterAction: RouterAction = {
  name: "LINEAR_WORKFLOW",
  description: "Route Linear workflow, activity, and issue search operations.",
  descriptionCompressed: "route Linear workflow activity search issue category",
  similes: [],
  contexts: ["general", "automation", "knowledge", LINEAR_WORKFLOW_CONTEXT],
  actionGroup: { contexts: [LINEAR_WORKFLOW_CONTEXT] },
  roleGate: { minRole: "USER" },
  validate: (runtime, message) =>
    validateRouter(runtime, message, workflowRoutes, /\b(linear|activity|search|issues?|bugs?)\b/i),
  handler: (runtime, message, state, options, callback) =>
    dispatchRoute<LinearWorkflowRouterResultData>(
      "LINEAR_WORKFLOW",
      workflowRoutes,
      runtime,
      message,
      state,
      options,
      callback
    ),
  parameters: [
    {
      name: "action",
      description: "Workflow operation to run.",
      required: false,
      schema: { type: "string", enum: ["get_activity", "clear_activity", "search_issues"] },
    },
    linearAccountIdParameter,
  ],
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Search open Linear bugs for the backend team" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll search Linear issues with those filters.",
          actions: ["LINEAR_WORKFLOW"],
        },
      },
    ],
  ],
};
