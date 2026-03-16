/**
 * App Deployment API
 *
 * Triggers Vercel deployments for an app from its GitHub repository.
 * Requires the app to have:
 * 1. A GitHub repository
 * 2. A subdomain assigned
 * 3. Vercel deployment configuration
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { appsService } from "@/lib/services/apps";
import { vercelDeploymentsService } from "@/lib/services/vercel-deployments";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { apps } from "@/db/schemas";
import { eq } from "drizzle-orm";
import type { AppDeploymentStatus } from "@/db/schemas";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const DeploySchema = z.object({
  /** Git branch to deploy (default: main) */
  branch: z.string().optional().default("main"),
  /** Deployment target (default: production) */
  target: z.enum(["production", "preview"]).optional().default("production"),
  /** Specific commit SHA to deploy */
  commitSha: z.string().optional(),
});

/**
 * POST /api/v1/apps/:id/deploy
 *
 * Trigger a new deployment for an app.
 *
 * @param request - Request body with optional branch, target, and commitSha
 * @returns Deployment result with deployment ID and URL
 */
export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const user = await requireAuthWithOrg();
  const { id: appId } = await params;

  // Verify app ownership
  const app = await appsService.getById(appId);
  if (!app || app.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "App not found" },
      { status: 404 },
    );
  }

  // Check if deployment is configured
  if (!vercelDeploymentsService.isDeploymentConfigured()) {
    return NextResponse.json(
      {
        success: false,
        error: "Deployment is not configured. Please contact support.",
      },
      { status: 503 },
    );
  }

  // Check if app has a GitHub repo
  if (!app.github_repo) {
    return NextResponse.json(
      {
        success: false,
        error: "App does not have a GitHub repository. Create one first.",
      },
      { status: 400 },
    );
  }

  // Parse request body
  const body = await request.json().catch(() => ({}));
  const validation = DeploySchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request data",
        details: validation.error.format(),
      },
      { status: 400 },
    );
  }

  const { branch, target, commitSha } = validation.data;

  logger.info("[Deploy API] Triggering deployment", {
    appId,
    userId: user.id,
    branch,
    target,
    commitSha,
  });

  // Update deployment status to "deploying"
  await dbWrite
    .update(apps)
    .set({
      deployment_status: "deploying" as AppDeploymentStatus,
      updated_at: new Date(),
    })
    .where(eq(apps.id, appId));

  // Trigger deployment
  const result = await vercelDeploymentsService.createDeployment(appId, {
    branch,
    target,
    commitSha,
  });

  if (!result.success) {
    // Update status to "failed" on error
    await dbWrite
      .update(apps)
      .set({
        deployment_status: "failed" as AppDeploymentStatus,
        updated_at: new Date(),
      })
      .where(eq(apps.id, appId));

    return NextResponse.json(
      { success: false, error: result.error },
      { status: 500 },
    );
  }

  // If deployment was triggered successfully, update status to "deployed"
  // and set the production URL
  // Note: In production, this should be updated via webhook when deployment completes
  if (result.productionUrl) {
    await dbWrite
      .update(apps)
      .set({
        deployment_status: "deployed" as AppDeploymentStatus,
        production_url: result.productionUrl,
        last_deployed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(apps.id, appId));
  }

  return NextResponse.json({
    success: true,
    deploymentId: result.deploymentId,
    deploymentUrl: result.deploymentUrl,
    productionUrl: result.productionUrl,
  });
}

/**
 * GET /api/v1/apps/:id/deploy
 *
 * Get deployment status and history for an app.
 *
 * @returns Deployment information including production URL and recent deployments
 */
export async function GET(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const user = await requireAuthWithOrg();
  const { id: appId } = await params;

  // Verify app ownership
  const app = await appsService.getById(appId);
  if (!app || app.organization_id !== user.organization_id) {
    return NextResponse.json(
      { success: false, error: "App not found" },
      { status: 404 },
    );
  }

  // Get production URL
  const productionUrl = await vercelDeploymentsService.getProductionUrl(appId);

  // Get recent deployments
  const deployments = await vercelDeploymentsService.listDeployments(appId, 10);

  // Check if deployment is configured
  const deploymentConfigured =
    vercelDeploymentsService.isDeploymentConfigured();

  return NextResponse.json({
    success: true,
    productionUrl,
    deploymentConfigured,
    githubRepo: app.github_repo,
    recentDeployments: deployments,
  });
}
