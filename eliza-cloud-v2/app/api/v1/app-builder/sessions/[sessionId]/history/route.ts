import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { aiAppBuilder } from "@/lib/services/ai-app-builder";
import { appsService } from "@/lib/services/apps";
import { githubReposService } from "@/lib/services/github-repos";
import { logger } from "@/lib/utils/logger";

interface RouteParams {
  params: Promise<{ sessionId: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { sessionId } = await params;

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

    // Need app with GitHub repo to get history
    if (!session.app_id) {
      return NextResponse.json({
        success: true,
        commits: [],
      });
    }

    const app = await appsService.getById(session.app_id);
    if (!app?.github_repo) {
      return NextResponse.json({
        success: true,
        commits: [],
      });
    }

    const repoName = app.github_repo.split("/").pop() || app.github_repo;

    try {
      const commits = await githubReposService.listCommits(repoName, {
        limit: 20,
      });
      return NextResponse.json({
        success: true,
        commits,
      });
    } catch (error) {
      logger.warn("Failed to fetch commit history", {
        sessionId,
        repoName,
        error: error instanceof Error ? error.message : "Unknown",
      });
      return NextResponse.json({
        success: true,
        commits: [],
      });
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to get history";
    const status =
      message.includes("Unauthorized") || message.includes("Authentication")
        ? 401
        : message.includes("Access denied") || message.includes("don't own")
          ? 403
          : message.includes("not found")
            ? 404
            : 500;

    logger.error("Failed to get session history", { error: message });
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
