import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { appsService } from "@/lib/services/apps";
import { gitSyncService } from "@/lib/services/git-sync";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

const RollbackSchema = z.object({
  commitSha: z.string().min(7).max(40),
});

/**
 * POST /api/v1/app-builder/sessions/[sessionId]/rollback
 *
 * Rolls back the sandbox to a specific commit.
 * This performs a hard reset to the specified commit and refreshes the sandbox.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

    // Verify session ownership
    const session = await aiAppBuilder.verifySessionOwnership(
      sessionId,
      user.id,
    );
    if (!session) {
      return NextResponse.json(
        { success: false, error: "Session not found" },
        { status: 404 },
      );
    }

    // Need app with GitHub repo to rollback
    if (!session.app_id) {
      return NextResponse.json(
        { success: false, error: "No app associated with this session" },
        { status: 400 },
      );
    }

    const app = await appsService.getById(session.app_id);
    if (!app?.github_repo) {
      return NextResponse.json(
        { success: false, error: "No GitHub repository configured" },
        { status: 400 },
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const parseResult = RollbackSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid commit SHA",
          details: parseResult.error.format(),
        },
        { status: 400 },
      );
    }

    const { commitSha } = parseResult.data;

    logger.info("Rolling back sandbox to commit", {
      sessionId,
      sandboxId: session.sandbox_id,
      commitSha,
      appId: session.app_id,
    });

    // Perform the rollback using git reset --hard
    const rollbackResult = await performRollback(
      session.sandbox_id,
      commitSha,
      app.github_repo,
    );

    if (!rollbackResult.success) {
      logger.error("Rollback failed", {
        sessionId,
        commitSha,
        error: rollbackResult.error,
      });
      return NextResponse.json(
        { success: false, error: rollbackResult.error },
        { status: 500 },
      );
    }

    logger.info("Rollback successful", {
      sessionId,
      commitSha: rollbackResult.currentSha,
    });

    return NextResponse.json({
      success: true,
      message: `Rolled back to ${commitSha.substring(0, 7)}`,
      currentSha: rollbackResult.currentSha,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to rollback";
    const status =
      message.includes("Unauthorized") || message.includes("Authentication")
        ? 401
        : message.includes("Access denied") || message.includes("don't own")
          ? 403
          : message.includes("not found")
            ? 404
            : 500;

    logger.error("Rollback request failed", { error: message });
    return NextResponse.json({ success: false, error: message }, { status });
  }
}

interface RollbackResult {
  success: boolean;
  currentSha?: string;
  error?: string;
}

/**
 * Performs the actual git rollback in the sandbox.
 * Uses git fetch + reset --hard to ensure clean state.
 */
async function performRollback(
  sandboxId: string,
  commitSha: string,
  repoFullName: string,
): Promise<RollbackResult> {
  try {
    // First ensure git is configured properly
    const repoName = repoFullName.includes("/")
      ? repoFullName.split("/").pop()!
      : repoFullName;

    const configResult = await gitSyncService.configureGit({
      sandboxId,
      repoFullName: repoName,
      branch: "main",
    });

    if (!configResult.success) {
      return {
        success: false,
        error: `Failed to configure git: ${configResult.error}`,
      };
    }

    // Get the sandbox instance to run commands
    const sandbox = getSandboxInstance(sandboxId);
    if (!sandbox) {
      return {
        success: false,
        error: "Sandbox not available",
      };
    }

    // Fetch latest from remote to ensure we have the commit
    const fetchResult = await sandbox.runCommand({
      cmd: "git",
      args: ["fetch", "origin", "--all"],
    });

    if (fetchResult.exitCode !== 0) {
      const stderr = await fetchResult.stderr();
      logger.warn("Git fetch had issues", { stderr });
      // Continue anyway - commit might be local
    }

    // Perform hard reset to the specified commit
    const resetResult = await sandbox.runCommand({
      cmd: "git",
      args: ["reset", "--hard", commitSha],
    });

    if (resetResult.exitCode !== 0) {
      const stderr = await resetResult.stderr();
      return {
        success: false,
        error: `Git reset failed: ${stderr}`,
      };
    }

    // Clean any untracked files
    await sandbox.runCommand({
      cmd: "git",
      args: ["clean", "-fd"],
    });

    // Reinstall dependencies if package.json changed
    const installResult = await sandbox.runCommand({
      cmd: "npm",
      args: ["install"],
    });

    if (installResult.exitCode !== 0) {
      logger.warn("npm install had issues after rollback", {
        sandboxId,
        exitCode: installResult.exitCode,
      });
      // Don't fail - the rollback itself succeeded
    }

    // Get current commit SHA to confirm
    const shaResult = await sandbox.runCommand({
      cmd: "git",
      args: ["rev-parse", "HEAD"],
    });

    const currentSha = (await shaResult.stdout()).trim();

    return {
      success: true,
      currentSha,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Gets the active sandbox instance from global state.
 */
function getSandboxInstance(sandboxId: string) {
  const sandboxes = (global as any).__sandboxInstances as
    | Map<string, any>
    | undefined;
  return sandboxes?.get(sandboxId) || null;
}
