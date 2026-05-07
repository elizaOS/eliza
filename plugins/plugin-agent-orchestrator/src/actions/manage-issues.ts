/**
 * MANAGE_ISSUES action - Create, list, update, and close GitHub issues
 *
 * Provides full issue lifecycle management through the CodingWorkspaceService.
 * Supports creating issues, listing issues, adding comments, closing, and reopening.
 *
 * @module actions/manage-issues
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
import { logger } from "@elizaos/core";
import { getCoordinator } from "../services/pty-service.js";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import type { AuthPromptCallback } from "../services/workspace-github.js";
import type { CodingWorkspaceService } from "../services/workspace-service.js";

const ISSUE_RESULT_LIMIT = 25;
const ISSUE_BODY_MAX_CHARS = 4_000;

function formatGitHubAuthPrompt(
  prompt: Parameters<AuthPromptCallback>[0],
): string {
  return (
    `I need GitHub access to manage issues. Please authorize me:\n\n` +
    `Go to: ${prompt.verificationUri}\n` +
    `Enter code: **${prompt.userCode}**\n\n` +
    `This code expires in ${Math.floor(prompt.expiresIn / 60)} minutes. ` +
    `I'll wait for you to complete authorization...`
  );
}

export const manageIssuesAction: Action = {
  name: "MANAGE_ISSUES",
  contexts: ["code", "tasks", "connectors", "automation"],
  contextGate: { anyOf: ["code", "tasks", "connectors", "automation"] },
  roleGate: { minRole: "USER" },

  similes: [
    "CREATE_ISSUE",
    "LIST_ISSUES",
    "CLOSE_ISSUE",
    "COMMENT_ISSUE",
    "UPDATE_ISSUE",
    "GET_ISSUE",
  ],

  description:
    "Manage GitHub issues for a repository. " +
    "Supports creating issues, listing issues, getting issue details, " +
    "adding comments, updating, closing, and reopening issues.",
  descriptionCompressed:
    "manage GitHub issue repository support create issue, list issue, get issue detail, add comment, updat, close, reopen issue",

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Create an issue on the testbed repo to add a login page",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll create that issue for you.",
          action: "MANAGE_ISSUES",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "List the open issues on HaruHunab1320/git-workspace-service-testbed",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check the open issues for that repo.",
          action: "MANAGE_ISSUES",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Close issue #3 on the testbed repo" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll close that issue.",
          action: "MANAGE_ISSUES",
        },
      },
    ],
  ],

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const workspaceService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;
    return workspaceService != null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult | undefined> => {
    const access = await requireTaskAgentAccess(runtime, message, "interact");
    if (!access.allowed) {
      if (callback) {
        await callback({ text: access.reason });
      }
      return { success: false, error: "FORBIDDEN", text: access.reason };
    }

    const workspaceService = runtime.getService(
      "CODING_WORKSPACE_SERVICE",
    ) as unknown as CodingWorkspaceService | undefined;
    if (!workspaceService) {
      if (callback) {
        await callback({ text: "Workspace Service is not available." });
      }
      return { success: false, error: "SERVICE_UNAVAILABLE" };
    }

    // Wire auth prompt through the coordinator chat bridge. The action
    // callback is buffered until the handler returns, which is too late for a
    // device-flow prompt that blocks while polling.
    workspaceService.setAuthPromptCallback((prompt) => {
      const delivered =
        getCoordinator(runtime)?.sendChatMessage(
          formatGitHubAuthPrompt(prompt),
          "github-auth",
        ) === true;
      if (!delivered) {
        logger.warn(
          "[MANAGE_ISSUES] GitHub OAuth prompt requires immediate delivery, but the coordinator chat bridge is not wired",
        );
      }
      return delivered;
    });

    const params = options?.parameters;
    const content = message.content as Record<string, unknown>;
    const text = ((content.text as string) ?? "").slice(0, ISSUE_BODY_MAX_CHARS);

    const operation =
      (params?.operation as string) ??
      (content.operation as string) ??
      inferOperation(text);
    const repo = (params?.repo as string) ?? (content.repo as string);

    if (!repo) {
      // Try to extract repo from text
      const urlMatch = text?.match(
        /(?:https?:\/\/github\.com\/)?([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/,
      );
      if (!urlMatch) {
        if (callback) {
          await callback({
            text: "Please specify a repository (e.g., owner/repo or a GitHub URL).",
          });
        }
        return { success: false, error: "MISSING_REPO" };
      }
      return handleOperation(
        workspaceService,
        urlMatch[1],
        operation,
        params ?? content,
        text,
        callback,
      );
    }

    return handleOperation(
      workspaceService,
      repo,
      operation,
      params ?? content,
      text,
      callback,
    );
  },

  parameters: [
    {
      name: "operation",
      description:
        "The operation to perform: create, list, get, update, comment, close, reopen, add_labels",
      descriptionCompressed:
        "Manage GitHub issues: create, list, comment, close, reopen.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "repo",
      description: "Repository in owner/repo format or full GitHub URL.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description: "Issue title (for create operation).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "body",
      description: "Issue body/description (for create or comment operations).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "issueNumber",
      description:
        "Issue number (for get, update, comment, close, reopen operations).",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "labels",
      description: "Labels to add (comma-separated string or array).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "state",
      description:
        "Filter by state: open, closed, or all (for list operation).",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

async function handleOperation(
  service: CodingWorkspaceService,
  repo: string,
  operation: string,
  params: Record<string, unknown>,
  originalText: string,
  callback?: HandlerCallback,
): Promise<ActionResult | undefined> {
  try {
    switch (operation.toLowerCase()) {
      case "create": {
        const title = params.title as string;
        const body = params.body as string | undefined;

        // Support batch create: if no explicit title but text contains numbered items, create multiple
        if (!title) {
          const items = extractBulkItems(
            (params.text as string) ?? originalText,
          );
          if (items.length > 0) {
            const labels = parseLabels(params.labels);
            const created = [];
            for (const item of items.slice(0, ISSUE_RESULT_LIMIT)) {
              const issue = await service.createIssue(repo, {
                title: item.title,
                body: item.body ?? "",
                labels: labels.length > 0 ? labels : undefined,
              });
              created.push(issue);
            }
            if (callback) {
              const summary = created
                .map((i) => `#${i.number}: ${i.title}\n  ${i.url}`)
                .join("\n");
              await callback({
                text: `Created ${created.length} issues:\n${summary}`,
              });
            }
            return { success: true, data: { issues: created } };
          }

          if (callback)
            await callback({ text: "Issue title is required for create." });
          return { success: false, error: "MISSING_TITLE" };
        }

        const labels = parseLabels(params.labels);
        const issue = await service.createIssue(repo, {
          title,
          body: body ?? "",
          labels: labels.length > 0 ? labels : undefined,
        });
        if (callback) {
          await callback({
            text: `Created issue #${issue.number}: ${issue.title}\n${issue.url}`,
          });
        }
        return { success: true, data: { issue } };
      }

      case "list": {
        const stateFilter = (params.state as string) ?? "open";
        const labels = parseLabels(params.labels);
        const issues = (
          await service.listIssues(repo, {
          state: stateFilter as "open" | "closed" | "all",
          labels: labels.length > 0 ? labels : undefined,
          })
        ).slice(0, ISSUE_RESULT_LIMIT);
        if (callback) {
          if (issues.length === 0) {
            await callback({
              text: `No ${stateFilter} issues found in ${repo}.`,
            });
          } else {
            const summary = issues
              .map(
                (i) =>
                  `#${i.number} [${i.state}] ${i.title}${i.labels.length > 0 ? ` (${i.labels.join(", ")})` : ""}`,
              )
              .join("\n");
            await callback({ text: `Issues in ${repo}:\n${summary}` });
          }
        }
        return { success: true, data: { issues } };
      }

      case "get": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.getIssue(repo, issueNumber);
        if (callback) {
          await callback({
            text: `Issue #${issue.number}: ${issue.title} [${issue.state}]\n\n${issue.body.slice(0, ISSUE_BODY_MAX_CHARS)}\n\nLabels: ${issue.labels.join(", ") || "none"}\n${issue.url}`,
          });
        }
        return { success: true, data: { issue } };
      }

      case "update": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const labels = parseLabels(params.labels);
        const issue = await service.updateIssue(repo, issueNumber, {
          title: params.title as string | undefined,
          body: params.body as string | undefined,
          labels: labels.length > 0 ? labels : undefined,
        });
        if (callback) {
          await callback({
            text: `Updated issue #${issue.number}: ${issue.title}`,
          });
        }
        return { success: true, data: { issue } };
      }

      case "comment": {
        const issueNumber = Number(params.issueNumber);
        const body = params.body as string;
        if (!issueNumber || !body) {
          if (callback)
            await callback({
              text: "Issue number and comment body are required.",
            });
          return { success: false, error: "MISSING_PARAMS" };
        }
        const comment = await service.addComment(repo, issueNumber, body);
        if (callback) {
          await callback({
            text: `Added comment to issue #${issueNumber}: ${comment.url}`,
          });
        }
        return { success: true, data: { comment } };
      }

      case "close": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.closeIssue(repo, issueNumber);
        if (callback) {
          await callback({
            text: `Closed issue #${issue.number}: ${issue.title}`,
          });
        }
        return { success: true, data: { issue } };
      }

      case "reopen": {
        const issueNumber = Number(params.issueNumber);
        if (!issueNumber) {
          if (callback) await callback({ text: "Issue number is required." });
          return { success: false, error: "MISSING_ISSUE_NUMBER" };
        }
        const issue = await service.reopenIssue(repo, issueNumber);
        if (callback) {
          await callback({
            text: `Reopened issue #${issue.number}: ${issue.title}`,
          });
        }
        return { success: true, data: { issue } };
      }

      case "add_labels": {
        const issueNumber = Number(params.issueNumber);
        const labels = parseLabels(params.labels);
        if (!issueNumber || labels.length === 0) {
          if (callback)
            await callback({ text: "Issue number and labels are required." });
          return { success: false, error: "MISSING_PARAMS" };
        }
        await service.addLabels(repo, issueNumber, labels);
        if (callback) {
          await callback({
            text: `Added labels [${labels.join(", ")}] to issue #${issueNumber}`,
          });
        }
        return { success: true };
      }

      default:
        if (callback) {
          await callback({
            text: `Unknown operation: ${operation}. Use: create, list, get, update, comment, close, reopen, add_labels`,
          });
        }
        return { success: false, error: "UNKNOWN_OPERATION" };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (callback) {
      await callback({ text: `Issue operation failed: ${errorMessage}` });
    }
    return { success: false, error: errorMessage };
  }
}

/**
 * Extract multiple issue titles/bodies from text containing numbered or bulleted items.
 * E.g. "1) Add a login page 2) Fix the bug 3) Add tests"
 */
function extractBulkItems(
  text: string,
): Array<{ title: string; body?: string }> {
  if (!text) return [];

  // Match numbered items: "1) ...", "1. ...", "1: ..."
  const numberedPattern =
    /(?:^|\s)(\d+)[).:-]\s*(.+?)(?=(?:\s+\d+[).:-]\s)|$)/gs;
  const items: Array<{ title: string; body?: string }> = [];

  for (const match of text.matchAll(numberedPattern)) {
    const raw = match[2].trim();
    if (raw.length > 0) {
      items.push({ title: raw });
    }
  }

  if (items.length >= 2) return items;

  // Fallback: split by common delimiters like " - " or newlines with bullets
  const bulletPattern = /(?:^|\n)\s*[-*•]\s+(.+)/g;
  const bulletItems: Array<{ title: string; body?: string }> = [];
  for (const match of text.matchAll(bulletPattern)) {
    const raw = match[1].trim();
    if (raw.length > 0) {
      bulletItems.push({ title: raw });
    }
  }

  if (bulletItems.length >= 2) return bulletItems;

  return [];
}

/**
 * Infer the operation from the user's message text when the LLM
 * doesn't explicitly set the operation parameter.
 */
function inferOperation(text: string): string {
  const lower = text.toLowerCase();

  // Order matters: check more specific patterns first
  if (/\b(create|open|file|submit|make|add)\b.*\bissue/.test(lower))
    return "create";
  if (/\bissue.*\b(create|open|file|submit|make)\b/.test(lower))
    return "create";
  if (/\b(close|resolve)\b.*\bissue/.test(lower)) return "close";
  if (/\bissue.*\b(close|resolve)\b/.test(lower)) return "close";
  if (/\b(reopen|re-open)\b.*\bissue/.test(lower)) return "reopen";
  if (/\b(comment|reply)\b.*\bissue/.test(lower)) return "comment";
  if (/\bissue.*\b(comment|reply)\b/.test(lower)) return "comment";
  if (/\b(update|edit|modify)\b.*\bissue/.test(lower)) return "update";
  if (/\bissue.*\b(update|edit|modify)\b/.test(lower)) return "update";
  if (/\b(label|tag)\b.*\bissue/.test(lower)) return "add_labels";
  if (/\bget\b.*\bissue\s*#?\d/.test(lower)) return "get";
  if (/\bissue\s*#?\d/.test(lower) && !/\b(list|show|all)\b/.test(lower))
    return "get";
  if (/\b(list|show|check|what are)\b.*\bissue/.test(lower)) return "list";

  return "list";
}

function parseLabels(input: unknown): string[] {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(String);
  if (typeof input === "string")
    return input
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}
