/**
 * Implements the LINEAR umbrella and its promoted my-issues, search, issue,
 * and teams read actions. The handler is the planner-facing boundary: typed
 * LinearError failures are translated into structured unsuccessful results
 * with retry metadata, while programming errors continue to throw.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { LinearError } from "./errors.js";
import { getLinearService } from "./service.js";
import {
  type LinearIssue,
  type LinearIssuePage,
  linearWorkflowStateTypes,
} from "./types.js";

const LINEAR_SUBACTIONS = ["my_issues", "search", "issue", "teams"] as const;
type LinearSubaction = (typeof LINEAR_SUBACTIONS)[number];

type Params = Record<string, unknown> & { action?: LinearSubaction };

function parameters(message: Memory, options?: HandlerOptions): Params {
  const values: Record<string, unknown> = {
    ...((options?.parameters ?? {}) as Record<string, unknown>),
  };
  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(message.content)) {
      if (values[key] === undefined) values[key] = value;
    }
  }
  return values as Params;
}

function invalidParameter(name: string, requirement: string): LinearError {
  return new LinearError(
    `The Linear ${name} parameter must be ${requirement}.`,
    { code: "LINEAR_INVALID_INPUT" },
  );
}

// A parameter that was supplied with the wrong type or range is rejected at
// this boundary; only a genuinely absent parameter may fall back to defaults.
function text(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw invalidParameter(name, "a non-empty string");
  }
  return value.trim();
}

function opaqueText(params: Params, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidParameter(name, "a non-empty string");
  }
  return value;
}

function integer(
  params: Params,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw invalidParameter(name, `an integer from ${min} to ${max}`);
  }
  return value;
}

function bool(params: Params, name: string): boolean | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidParameter(name, "a boolean");
  return value;
}

function normalizeAction(value: unknown): LinearSubaction | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return LINEAR_SUBACTIONS.includes(normalized as LinearSubaction)
    ? (normalized as LinearSubaction)
    : null;
}

function stateType(value: unknown): (typeof linearWorkflowStateTypes)[number] {
  const normalized =
    typeof value === "string" && value.trim()
      ? value.trim().toLowerCase()
      : undefined;
  if (
    !normalized ||
    !linearWorkflowStateTypes.includes(
      normalized as (typeof linearWorkflowStateTypes)[number],
    )
  ) {
    throw new LinearError(
      `The Linear state filter must be one of: ${linearWorkflowStateTypes.join(", ")}.`,
      { code: "LINEAR_INVALID_INPUT" },
    );
  }
  return normalized as (typeof linearWorkflowStateTypes)[number];
}

function issueLine(issue: LinearIssue): string {
  const assignee = issue.assignee ? ` @${issue.assignee.name}` : "";
  return `${issue.identifier} · ${issue.title} (${issue.state.name}${assignee}) ${issue.url}`;
}

function issuePageText(page: LinearIssuePage, heading: string): string {
  if (page.issues.length === 0) return `${heading}: no matching Linear issues.`;
  const lines = page.issues.map(issueLine).join("\n");
  const more = page.nextCursor ? "\nMore issues are available." : "";
  return `${heading}:\n${lines}${more}`;
}

async function result(
  action: LinearSubaction,
  value: ActionResult,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  await callback?.({
    text: value.userFacingText ?? value.text,
    actions: [`LINEAR_${action.toUpperCase()}`],
  });
  return value;
}

function actionError(error: LinearError): ActionResult {
  const retryable =
    error.code === "LINEAR_RATE_LIMITED" ||
    error.code === "LINEAR_PROVIDER_FAILURE" ||
    error.code === "LINEAR_PROVIDER_TIMEOUT" ||
    error.code === "LINEAR_PROVIDER_NETWORK";
  return {
    success: false,
    text: error.message,
    userFacingText: error.message,
    verifiedUserFacing: true,
    data: {
      actionName: "LINEAR",
      code: error.code,
      retryable,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    },
  };
}

async function execute(
  runtime: IAgentRuntime,
  message: Memory,
  _state: State | undefined,
  options?: HandlerOptions,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const params = parameters(message, options);
  const action = normalizeAction(params.action) ?? "my_issues";
  try {
    const service = getLinearService(runtime);
    const cursor = opaqueText(params, "cursor");
    const limit = integer(params, "limit", 1, 100);
    switch (action) {
      case "my_issues": {
        const teamKey = text(params, "teamKey");
        const page = await service.searchIssues({
          assignedToMe: true,
          ...(teamKey ? { teamKey } : {}),
          ...(params.state !== undefined
            ? { stateType: stateType(params.state) }
            : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const userFacingText = issuePageText(page, "Your Linear issues");
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: { actionName: "LINEAR", action, page },
          },
          callback,
        );
      }
      case "search": {
        const query = text(params, "query");
        const teamKey = text(params, "teamKey");
        if (!query && !teamKey && params.state === undefined) {
          throw new LinearError(
            "Linear issue search requires a query, teamKey, or state filter.",
            { code: "LINEAR_INVALID_INPUT" },
          );
        }
        const page = await service.searchIssues({
          ...(query ? { query } : {}),
          ...(teamKey ? { teamKey } : {}),
          ...(params.state !== undefined
            ? { stateType: stateType(params.state) }
            : {}),
          ...(bool(params, "assignedToMe") ? { assignedToMe: true } : {}),
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const userFacingText = issuePageText(page, "Linear search results");
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: { actionName: "LINEAR", action, page },
          },
          callback,
        );
      }
      case "issue": {
        const identifier = text(params, "identifier");
        if (!identifier) {
          throw new LinearError(
            "Linear issue lookup requires an identifier such as ENG-123.",
            { code: "LINEAR_INVALID_INPUT" },
          );
        }
        const issue = await service.getIssue(identifier);
        if (!issue) {
          const userFacingText = `Linear issue ${identifier} was not found.`;
          return result(
            action,
            {
              success: false,
              text: userFacingText,
              userFacingText,
              verifiedUserFacing: true,
              data: {
                actionName: "LINEAR",
                action,
                code: "LINEAR_NOT_FOUND",
                identifier,
              },
            },
            callback,
          );
        }
        const userFacingText = issueLine(issue);
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: { actionName: "LINEAR", action, issue },
          },
          callback,
        );
      }
      case "teams": {
        const page = await service.listTeams({
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        const userFacingText =
          page.teams.length === 0
            ? "This Linear workspace has no visible teams."
            : `Linear teams:\n${page.teams
                .map((team) => `${team.key} · ${team.name}`)
                .join(
                  "\n",
                )}${page.nextCursor ? "\nMore teams are available." : ""}`;
        return result(
          action,
          {
            success: true,
            text: userFacingText,
            userFacingText,
            verifiedUserFacing: true,
            data: { actionName: "LINEAR", action, page },
          },
          callback,
        );
      }
    }
  } catch (error) {
    // error-policy:J1 The action boundary translates typed domain/provider
    // failures for the planner; unexpected programming errors still throw.
    if (error instanceof LinearError)
      return result(action, actionError(error), callback);
    throw error;
  }
}

export const linearAction: Action = {
  name: "LINEAR",
  similes: ["LINEAR_ISSUES", "ISSUE_TRACKER", "WORK_TRACKING", "SPRINT"],
  description:
    "Look up Linear issues assigned to the user, search workspace issues, inspect one issue, or list teams. Use the specific promoted LINEAR_* action when the requested operation is known.",
  descriptionCompressed:
    "Linear issues: my assigned issues, workspace search, issue detail, teams.",
  contexts: ["work", "productivity"],
  routingHint:
    "Use LINEAR_MY_ISSUES for the user's assigned issues, LINEAR_SEARCH to search workspace issues, LINEAR_ISSUE for one issue by identifier, and LINEAR_TEAMS to list teams.",
  tags: ["domain:work", "capability:read"],
  parameters: [
    {
      name: "action",
      description: "Linear operation.",
      required: false,
      schema: { type: "string", enum: [...LINEAR_SUBACTIONS] },
    },
    {
      name: "query",
      description: "Issue title text to search for.",
      required: false,
      schema: { type: "string" },
      subactions: ["search"],
    },
    {
      name: "identifier",
      description: "Issue identifier such as ENG-123.",
      required: false,
      schema: { type: "string" },
      subactions: ["issue"],
    },
    {
      name: "teamKey",
      description: "Linear team key filter such as ENG.",
      required: false,
      schema: { type: "string" },
      subactions: ["my_issues", "search"],
    },
    {
      name: "state",
      description:
        "Workflow state type filter: triage | backlog | unstarted | started | completed | canceled.",
      required: false,
      schema: { type: "string", enum: [...linearWorkflowStateTypes] },
      subactions: ["my_issues", "search"],
    },
    {
      name: "assignedToMe",
      description: "Restrict search results to issues assigned to the user.",
      required: false,
      schema: { type: "boolean" },
      subactions: ["search"],
    },
    {
      name: "cursor",
      description: "Opaque pagination cursor from a previous page.",
      required: false,
      schema: { type: "string" },
      subactions: ["my_issues", "search", "teams"],
    },
    {
      name: "limit",
      description: "Result limit from 1 to 100.",
      required: false,
      schema: { type: "number" },
      subactions: ["my_issues", "search", "teams"],
    },
  ],
  validate: async (_runtime, _message, _state, options) => {
    const value = (options?.parameters as Record<string, unknown> | undefined)
      ?.action;
    return value === undefined || normalizeAction(value) !== null;
  },
  handler: execute,
};
