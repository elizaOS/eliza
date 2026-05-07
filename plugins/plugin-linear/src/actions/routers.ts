import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
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
  const requested = normalizeSubaction(readOptions(options).subaction);
  if (requested) {
    const route = routes.find((candidate) => candidate.subaction === requested);
    if (route) return route;
  }

  const text = textOf(message);
  return routes.find((route) => route.match.test(text)) ?? null;
}

function hasLinearAccess(runtime: IAgentRuntime): boolean {
  const apiKey = runtime.getSetting("LINEAR_API_KEY");
  return typeof apiKey === "string" && apiKey.trim().length > 0;
}

async function validateRouter(
  runtime: IAgentRuntime,
  message: Memory,
  routes: readonly LinearRoute[],
  fallback: RegExp
): Promise<boolean> {
  if (!hasLinearAccess(runtime)) return false;
  const text = textOf(message);
  if (!text.trim()) return false;
  return routes.some((route) => route.match.test(text)) || fallback.test(text);
}

async function dispatchRoute(
  routerName: string,
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
    return {
      success: false,
      text,
      values: { error: "MISSING_SUBACTION" },
      data: { actionName: routerName, availableSubactions: subactions },
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
  return {
    ...result,
    success: result.success ?? true,
    text,
    data: {
      ...(typeof result.data === "object" && result.data ? result.data : {}),
      actionName: routerName,
      routedActionName: route.action.name,
      subaction: route.subaction,
    },
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
    dispatchRoute("LINEAR_ISSUE", issueRoutes, runtime, message, state, options, callback),
  parameters: [
    {
      name: "subaction",
      description: "Issue operation to run.",
      required: false,
      schema: { type: "string", enum: ["create", "get", "update", "delete"] },
    },
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
    dispatchRoute("LINEAR_COMMENT", commentRoutes, runtime, message, state, options, callback),
  parameters: [
    {
      name: "subaction",
      description: "Comment operation to run.",
      required: false,
      schema: { type: "string", enum: ["create"] },
    },
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
    dispatchRoute("LINEAR_WORKFLOW", workflowRoutes, runtime, message, state, options, callback),
  parameters: [
    {
      name: "subaction",
      description: "Workflow operation to run.",
      required: false,
      schema: { type: "string", enum: ["get_activity", "clear_activity", "search_issues"] },
    },
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
