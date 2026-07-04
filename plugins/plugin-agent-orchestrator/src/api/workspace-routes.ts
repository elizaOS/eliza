/**
 * Workspace Route Handlers
 *
 * Handles routes for git workspace management:
 * - Provision (clone repos, create worktrees)
 * - Get status, commit, push, create PR, delete
 *
 * @module api/workspace-routes
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./route-utils.js";
import {
  asBoolean,
  asString,
  parseBody,
  sendError,
  sendJson,
} from "./route-utils.js";

/**
 * Handle workspace routes (/api/workspace/*)
 * Returns true if the route was handled, false otherwise
 */
export async function handleWorkspaceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method?.toUpperCase();

  // POST /api/workspace/provision
  if (method === "POST" && pathname === "/api/workspace/provision") {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const body = await parseBody(req);
      const repo = asString(body.repo);
      if (!repo) {
        sendError(res, "repo is required");
        return true;
      }
      const baseBranch = asString(body.baseBranch);
      const branchName = asString(body.branchName);
      const parentWorkspaceId = asString(body.parentWorkspaceId);
      const useWorktree = asBoolean(body.useWorktree);

      const workspace = await ctx.workspaceService.provisionWorkspace({
        repo,
        ...(baseBranch ? { baseBranch } : {}),
        ...(branchName ? { branchName } : {}),
        ...(useWorktree !== undefined ? { useWorktree } : {}),
        ...(parentWorkspaceId ? { parentWorkspaceId } : {}),
      });

      sendJson(
        res,
        {
          id: workspace.id,
          path: workspace.path,
          branch: workspace.branch,
          isWorktree: workspace.isWorktree,
        },
        201,
      );
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error
          ? error.message
          : "Failed to provision workspace",
        500,
      );
    }
    return true;
  }

  // GET /api/workspace/:id
  const workspaceMatch = pathname.match(/^\/api\/workspace\/([^/]+)$/);
  if (method === "GET" && workspaceMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const workspaceId = workspaceMatch[1];
      const status = await ctx.workspaceService.getStatus(workspaceId);
      sendJson(res, status);
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to get workspace",
        500,
      );
    }
    return true;
  }

  // POST /api/workspace/:id/commit
  const commitMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/commit$/);
  if (method === "POST" && commitMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const workspaceId = commitMatch[1];
      const body = await parseBody(req);
      const { message } = body;

      const result = await ctx.workspaceService.commit(workspaceId, {
        message: message as string,
        all: true,
      });

      sendJson(res, result);
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to commit",
        500,
      );
    }
    return true;
  }

  // POST /api/workspace/:id/push
  const pushMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/push$/);
  if (method === "POST" && pushMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const workspaceId = pushMatch[1];
      const body = await parseBody(req);
      const force = asBoolean(body.force);
      const setUpstream = asBoolean(body.setUpstream);

      const result = await ctx.workspaceService.push(workspaceId, {
        ...(force !== undefined ? { force } : {}),
        ...(setUpstream !== undefined ? { setUpstream } : {}),
      });

      sendJson(res, result);
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to push",
        500,
      );
    }
    return true;
  }

  // POST /api/workspace/:id/pr
  const prMatch = pathname.match(/^\/api\/workspace\/([^/]+)\/pr$/);
  if (method === "POST" && prMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const workspaceId = prMatch[1];
      const body = await parseBody(req);
      const title = asString(body.title);
      const prBody = asString(body.body);
      if (!title || !prBody) {
        sendError(res, "title and body are required");
        return true;
      }
      const base = asString(body.baseBranch);
      const draft = asBoolean(body.draft);

      const result = await ctx.workspaceService.createPR(workspaceId, {
        title,
        body: prBody,
        ...(base ? { base } : {}),
        ...(draft !== undefined ? { draft } : {}),
      });

      sendJson(res, result, 201);
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to create PR",
        500,
      );
    }
    return true;
  }

  // DELETE /api/workspace/:id
  const deleteMatch = pathname.match(/^\/api\/workspace\/([^/]+)$/);
  if (method === "DELETE" && deleteMatch) {
    if (!ctx.workspaceService) {
      sendError(res, "Workspace Service not available", 503);
      return true;
    }

    try {
      const workspaceId = deleteMatch[1];
      await ctx.workspaceService.removeWorkspace(workspaceId);
      sendJson(res, { success: true, workspaceId });
    } catch (error) {
      // error-policy:J1 route boundary → 500 structured error response
      sendError(
        res,
        error instanceof Error ? error.message : "Failed to remove workspace",
        500,
      );
    }
    return true;
  }

  // Route not handled
  return false;
}
