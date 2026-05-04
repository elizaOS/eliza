/**
 * Issue Route Handlers
 *
 * Handles routes for GitHub issue management:
 * - List issues, create issue
 * - Get issue, comment on issue, close issue
 *
 * @module api/issue-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./routes.js";
import { parseBody, sendError, sendJson } from "./routes.js";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Handle issue routes (/api/issues/*)
 * Returns true if the route was handled, false otherwise
 */
export async function handleIssueRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method?.toUpperCase();

  // GET /api/issues?repo=owner/repo&state=open
  if (method === "GET" && pathname === "/api/issues") {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const repo = url.searchParams.get("repo");
      if (!repo) {
        sendError(res, "repo query parameter required", 400);
        return true;
      }
      const state = url.searchParams.get("state") as
        | "open"
        | "closed"
        | "all"
        | null;
      const labelsParam = url.searchParams.get("labels");
      const labels = labelsParam
        ? labelsParam.split(",").map((s) => s.trim())
        : undefined;

      const issues = await ctx.workspaceService.listIssues(repo, {
        state: state ?? "open",
        labels,
      });
      sendJson(res, issues as unknown as JsonValue);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to list issues",
        500,
      );
    }
    return true;
  }

  // POST /api/issues
  if (method === "POST" && pathname === "/api/issues") {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const body = await parseBody(req);
      const { repo, title, body: issueBody, labels } = body;
      if (!repo || !title) {
        sendError(res, "repo and title are required", 400);
        return true;
      }

      const issue = await ctx.workspaceService.createIssue(repo as string, {
        title: title as string,
        body: (issueBody as string) ?? "",
        labels: labels as string[] | undefined,
      });
      sendJson(res, issue as unknown as JsonValue, 201);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to create issue",
        500,
      );
    }
    return true;
  }

  // GET /api/issues/:repo/:number (e.g., /api/issues/owner/repo/42)
  const issueGetMatch = pathname.match(
    /^\/api\/issues\/([^/]+)\/([^/]+)\/(\d+)$/,
  );
  if (method === "GET" && issueGetMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const repo = `${issueGetMatch[1]}/${issueGetMatch[2]}`;
      const issueNumber = parseInt(issueGetMatch[3], 10);
      const issue = await ctx.workspaceService.getIssue(repo, issueNumber);
      sendJson(res, issue as unknown as JsonValue);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to get issue",
        500,
      );
    }
    return true;
  }

  // POST /api/issues/:repo/:number/comment
  const commentMatch = pathname.match(
    /^\/api\/issues\/([^/]+)\/([^/]+)\/(\d+)\/comment$/,
  );
  if (method === "POST" && commentMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const repo = `${commentMatch[1]}/${commentMatch[2]}`;
      const issueNumber = parseInt(commentMatch[3], 10);
      const body = await parseBody(req);
      if (!body.body) {
        sendError(res, "body is required", 400);
        return true;
      }
      const comment = await ctx.workspaceService.addComment(
        repo,
        issueNumber,
        body.body as string,
      );
      sendJson(res, comment as unknown as JsonValue, 201);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to add comment",
        500,
      );
    }
    return true;
  }

  // POST /api/issues/:repo/:number/close
  const closeMatch = pathname.match(
    /^\/api\/issues\/([^/]+)\/([^/]+)\/(\d+)\/close$/,
  );
  if (method === "POST" && closeMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const repo = `${closeMatch[1]}/${closeMatch[2]}`;
      const issueNumber = parseInt(closeMatch[3], 10);
      const issue = await ctx.workspaceService.closeIssue(repo, issueNumber);
      sendJson(res, issue as unknown as JsonValue);
    } catch (error) {
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to close issue",
        500,
      );
    }
    return true;
  }

  // Route not handled
  return false;
}
