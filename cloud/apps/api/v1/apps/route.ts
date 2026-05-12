/**
 * Apps API
 *
 * GET  /api/v1/apps  — list apps for the authed user's org
 * POST /api/v1/apps  — create a new app (provisions API key + optional GitHub repo)
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appFactoryService } from "@/lib/services/app-factory";
import { AppNameConflictError, appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CreateAppSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  app_url: z.string().url(),
  website_url: z.string().url().optional(),
  contact_email: z.string().email().optional(),
  allowed_origins: z.array(z.string()).optional(),
  logo_url: z.string().url().optional(),
  skipGitHubRepo: z.boolean().optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const apps = await appsService.listByOrganizationWithDatabaseState(user.organization_id);
    return c.json({ success: true, apps });
  } catch (error) {
    logger.error("[Apps API] Failed to list apps:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    const rawBody = await c.req.json();
    const validationResult = CreateAppSchema.safeParse(rawBody);
    if (!validationResult.success) {
      return c.json(
        {
          success: false,
          error: "Invalid request data",
          details: validationResult.error.format(),
        },
        400,
      );
    }
    const data = validationResult.data;

    try {
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
        { createGitHubRepo: !data.skipGitHubRepo },
      );

      logger.info(`[Apps API] Created app: ${result.app.name}`, {
        appId: result.app.id,
        userId: user.id,
        organizationId: user.organization_id,
        githubRepo: result.githubRepo,
        githubRepoCreated: result.githubRepoCreated,
      });

      const response: Record<string, unknown> = {
        success: true,
        app: await appsService.withDatabaseState(result.app),
        apiKey: result.apiKey,
      };
      if (result.githubRepo) response.githubRepo = result.githubRepo;
      if (result.errors.length > 0) response.warnings = result.errors;

      return c.json(response);
    } catch (err) {
      if (err instanceof AppNameConflictError) {
        logger.warn("[Apps API] App name conflict:", {
          conflictType: err.conflictType,
          suggestedName: err.suggestedName,
        });
        return c.json(
          {
            success: false,
            error: err.message,
            conflictType: err.conflictType,
            suggestedName: err.suggestedName,
          },
          409,
        );
      }
      throw err;
    }
  } catch (error) {
    logger.error("[Apps API] Failed to create app:", error);
    return failureResponse(c, error);
  }
});

export default app;
