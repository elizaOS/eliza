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
import { appCreditsService } from "@/lib/services/app-credits";
import { appFactoryService } from "@/lib/services/app-factory";
import {
  AppCreationLimitError,
  AppNameConflictError,
  appsService,
} from "@/lib/services/apps";
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
  // Optional monetization config applied immediately after creation. A `true`
  // enable request is never honored at create time — the app is created with
  // monetization off and the review requirement is returned in `warnings`
  // (enabling requires the same review approval as the PUT endpoint).
  monetization_enabled: z.boolean().optional(),
  inference_markup_percentage: z.number().min(0).max(1000).optional(),
});

/**
 * Warning returned when a create request asks for `monetization_enabled: true`.
 * Monetization requires an approved review, so the create is downgraded — the
 * app still exists, monetization stays off, and this string tells the caller
 * (human or agent) the exact next step (#11863).
 */
export const CREATE_TIME_MONETIZATION_WARNING =
  "Monetization requires an approved app review, so the app was created with monetization disabled. Submit it for review (the Monetize tab in the dashboard, or POST /api/v1/apps/:id/review), then enable monetization after approval.";

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const apps = await appsService.listByOrganizationWithDatabaseState(
      user.organization_id,
    );
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

    // Monetization can never be enabled at create time — it requires an
    // approved review (the same gate as PUT /apps/:id/monetization). Rather
    // than rejecting the whole request (which left agent/SDK "create a
    // monetized app" flows with a dead 403 and no app — #11863), the app is
    // created with monetization forced off and the review path is surfaced in
    // `warnings`. Requested pricing defaults still persist so enabling after
    // approval needs no re-entry.
    const monetizationDeferred = data.monetization_enabled === true;
    const monetizationEnabled = monetizationDeferred
      ? false
      : data.monetization_enabled;

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
        { createGitHubRepo: data.skipGitHubRepo === false },
      );

      logger.info(`[Apps API] Created app: ${result.app.name}`, {
        appId: result.app.id,
        userId: user.id,
        organizationId: user.organization_id,
        githubRepo: result.githubRepo,
        githubRepoCreated: result.githubRepoCreated,
      });

      const warnings = [...result.errors];
      if (monetizationDeferred) {
        warnings.push(CREATE_TIME_MONETIZATION_WARNING);
      }

      // Persist pricing defaults at creation when requested. Enabling
      // monetization is deliberately excluded (forced off above) because it
      // must pass the same approved-review gate as PUT /apps/:id/monetization.
      if (
        monetizationEnabled !== undefined ||
        data.inference_markup_percentage !== undefined
      ) {
        try {
          await appCreditsService.updateMonetizationSettings(result.app.id, {
            ...(monetizationEnabled !== undefined && {
              monetizationEnabled,
            }),
            ...(data.inference_markup_percentage !== undefined && {
              inferenceMarkupPercentage: data.inference_markup_percentage,
            }),
          });
        } catch (monetizationError) {
          logger.error("[Apps API] Failed to apply initial monetization", {
            appId: result.app.id,
            userId: user.id,
            error:
              monetizationError instanceof Error
                ? monetizationError.message
                : String(monetizationError),
          });
          warnings.push(
            "App was created, but initial monetization settings could not be applied. Retry via the app monetization endpoint.",
          );
        }
      }

      const freshApp = await appsService.getById(result.app.id);
      const response: Record<string, unknown> = {
        success: true,
        app: await appsService.withDatabaseState(freshApp ?? result.app),
        apiKey: result.apiKey,
      };
      if (result.githubRepo) response.githubRepo = result.githubRepo;
      if (warnings.length > 0) response.warnings = warnings;

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
      if (err instanceof AppCreationLimitError) {
        logger.warn("[Apps API] App creation limit reached:", {
          organizationId: err.organizationId,
          limit: err.limit,
        });
        return c.json(
          {
            success: false,
            error: err.message,
            code: "app_creation_limit_reached",
            limit: err.limit,
          },
          429,
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
