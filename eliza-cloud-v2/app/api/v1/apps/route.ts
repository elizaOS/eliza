import { NextRequest, NextResponse } from "next/server";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { appsService, AppNameConflictError } from "@/lib/services/apps";
import { appFactoryService } from "@/lib/services/app-factory";
import { logger } from "@/lib/utils/logger";
import { z } from "zod";

const CreateAppSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  app_url: z.string().url(),
  website_url: z.string().url().optional(),
  contact_email: z.string().email().optional(),
  allowed_origins: z.array(z.string()).optional(),
  logo_url: z.string().url().optional(),
  /** Whether to skip creating a GitHub repository (default: false) */
  skipGitHubRepo: z.boolean().optional(),
});

const CheckNameSchema = z.object({
  name: z.string().min(1).max(100),
});

/**
 * GET /api/v1/apps
 * Lists all apps for the authenticated user's organization.
 *
 * @param request - The Next.js request object.
 * @returns Array of app objects.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const apps = await appsService.listByOrganization(user.organization_id);
    return NextResponse.json({ success: true, apps });
  } catch (error) {
    logger.error("Failed to list apps:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list apps",
      },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/apps
 * Creates a new app for the authenticated user's organization.
 * Automatically generates an API key and GitHub repository for the app.
 *
 * @param request - Request body with app details (name, description, app_url, etc.).
 * @returns Created app details, API key, and GitHub repo info.
 */
export async function POST(request: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);

    const body = await request.json();
    const validationResult = CreateAppSchema.safeParse(body);

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

    const data = validationResult.data;

    // Use AppFactoryService for unified app creation with GitHub repo
    const result = await appFactoryService.createApp(
      {
        name: data.name,
        description: data.description,
        organization_id: user.organization_id,
        created_by_user_id: user.id,
        app_url: data.app_url,
        website_url: data.website_url,
        contact_email: data.contact_email,
        allowed_origins: data.allowed_origins,
        logo_url: data.logo_url,
      },
      {
        createGitHubRepo: !data.skipGitHubRepo,
      },
    );

    logger.info(`Created app: ${result.app.name}`, {
      appId: result.app.id,
      userId: user.id,
      organizationId: user.organization_id,
      githubRepo: result.githubRepo,
      githubRepoCreated: result.githubRepoCreated,
    });

    // Include warnings if there were non-fatal errors
    const response: Record<string, unknown> = {
      success: true,
      app: result.app,
      apiKey: result.apiKey,
    };

    if (result.githubRepo) {
      response.githubRepo = result.githubRepo;
    }

    if (result.errors.length > 0) {
      response.warnings = result.errors;
    }

    return NextResponse.json(response);
  } catch (error) {
    // Handle name conflict errors with helpful response
    if (error instanceof AppNameConflictError) {
      logger.warn("App name conflict:", {
        conflictType: error.conflictType,
        suggestedName: error.suggestedName,
      });
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          conflictType: error.conflictType,
          suggestedName: error.suggestedName,
        },
        { status: 409 }, // Conflict status code
      );
    }

    logger.error("Failed to create app:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create app",
      },
      { status: 500 },
    );
  }
}
