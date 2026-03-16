import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { appsService } from "@/lib/services/apps";
import { gitSyncService } from "@/lib/services/git-sync";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { appSandboxSessions } from "@/db/schemas/app-sandboxes";
import { eq } from "drizzle-orm";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

const CommitSchema = z.object({
  /** Commit message (optional - will auto-generate if not provided) */
  message: z.string().optional(),
  /** Specific files to commit (optional - commits all changes if not provided) */
  files: z.array(z.string()).optional(),
});

/**
 * POST /api/v1/app-builder/sessions/[sessionId]/commit
 *
 * Manually commit and push current sandbox changes to the app's GitHub repository.
 * This is useful for saving progress at specific points or before session expiry.
 *
 * @param request - Request body with optional message and files array
 * @returns Commit result with SHA and files committed count
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    // Parse and validate request body
    const body = await request.json().catch(() => ({}));
    const validationResult = CommitSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const { message, files } = validationResult.data;

    // Verify session ownership and get session data
    const session = await aiAppBuilder.verifySessionOwnership(
      sessionId,
      user.id,
    );

    if (!session.sandbox_id) {
      return NextResponse.json(
        { success: false, error: "Session has no active sandbox" },
        { status: 400 },
      );
    }

    if (!session.app_id) {
      return NextResponse.json(
        { success: false, error: "Session is not associated with an app" },
        { status: 400 },
      );
    }

    // Get the app's GitHub repo
    const app = await appsService.getById(session.app_id);
    if (!app?.github_repo) {
      return NextResponse.json(
        {
          success: false,
          error: "App does not have a GitHub repository configured",
        },
        { status: 400 },
      );
    }

    logger.info("Manual commit requested", {
      sessionId,
      appId: session.app_id,
      githubRepo: app.github_repo,
      hasCustomMessage: !!message,
      specificFiles: files?.length ?? "all",
    });

    // Generate commit message if not provided
    const commitMessage =
      message || `Manual save at ${new Date().toISOString()}`;

    // Perform the commit
    const commitResult = await gitSyncService.commitAndPush(
      {
        sandboxId: session.sandbox_id,
        repoFullName: app.github_repo,
        branch: "main",
      },
      {
        message: commitMessage,
        files,
      },
    );

    if (!commitResult.success) {
      logger.error("Manual commit failed", {
        sessionId,
        error: commitResult.error,
      });

      return NextResponse.json(
        {
          success: false,
          error: commitResult.error || "Failed to commit changes",
        },
        { status: 500 },
      );
    }

    // Update session with last commit info
    if (commitResult.commitSha) {
      await dbWrite
        .update(appSandboxSessions)
        .set({
          last_commit_sha: commitResult.commitSha,
          updated_at: new Date(),
        })
        .where(eq(appSandboxSessions.id, sessionId));
    }

    logger.info("Manual commit successful", {
      sessionId,
      commitSha: commitResult.commitSha,
      filesCommitted: commitResult.filesCommitted,
    });

    return NextResponse.json({
      success: true,
      commitSha: commitResult.commitSha,
      filesCommitted: commitResult.filesCommitted,
      message: commitMessage,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to commit changes";
    const status =
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Authentication")
        ? 401
        : errorMessage.includes("Access denied") ||
            errorMessage.includes("don't own")
          ? 403
          : errorMessage.includes("not found")
            ? 404
            : 500;

    logger.error("Manual commit error", { error: errorMessage });

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status },
    );
  }
}

/**
 * GET /api/v1/app-builder/sessions/[sessionId]/commit
 *
 * Get the current git status for the session's sandbox.
 * Shows what files have uncommitted changes.
 *
 * @returns Git status information
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    // Verify session ownership and get session data
    const session = await aiAppBuilder.verifySessionOwnership(
      sessionId,
      user.id,
    );

    if (!session.sandbox_id) {
      return NextResponse.json(
        { success: false, error: "Session has no active sandbox" },
        { status: 400 },
      );
    }

    // Get git status
    const status = await gitSyncService.getStatus(session.sandbox_id);

    if (!status) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Unable to get git status - sandbox may not be a git repository",
        },
        { status: 400 },
      );
    }

    // Get current commit SHA
    const currentSha = await gitSyncService.getCurrentCommitSha(
      session.sandbox_id,
    );

    return NextResponse.json({
      success: true,
      hasChanges: status.hasChanges,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      currentCommitSha: currentSha,
      lastSavedCommitSha: session.last_commit_sha,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get git status";
    const status =
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("Authentication")
        ? 401
        : errorMessage.includes("Access denied") ||
            errorMessage.includes("don't own")
          ? 403
          : errorMessage.includes("not found")
            ? 404
            : 500;

    logger.error("Get commit status error", { error: errorMessage });

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status },
    );
  }
}
