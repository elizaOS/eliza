/**
 * App detail API
 *
 * GET    /api/v1/apps/:id  — fetch the app
 * PUT    /api/v1/apps/:id  — replace fields
 * PATCH  /api/v1/apps/:id  — partial update
 * DELETE /api/v1/apps/:id  — full cleanup + delete
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appCleanupService } from "@/lib/services/app-cleanup";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const optionalUrl = z
  .preprocess((val) => (val === "" ? null : val), z.string().url().nullish())
  .optional();
const optionalEmail = z
  .preprocess((val) => (val === "" ? null : val), z.string().email().nullish())
  .optional();

const UpdateAppSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
  app_url: optionalUrl,
  website_url: optionalUrl,
  contact_email: optionalEmail,
  allowed_origins: z.array(z.string()).optional(),
  logo_url: optionalUrl,
  is_active: z.boolean().optional(),
  linked_character_ids: z.array(z.string().uuid()).max(4).optional(),
});

const app = new Hono<AppEnv>();

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing app id" }, 400);

    const found = await appsService.getById(id);
    if (!found) return c.json({ success: false, error: "App not found" }, 404);
    if (found.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    return c.json({ success: true, app: await appsService.withDatabaseState(found) });
  } catch (error) {
    logger.error("[Apps API] Failed to get app:", error);
    return failureResponse(c, error);
  }
});

async function updateApp(c: AppContext, verb: "PUT" | "PATCH") {
  const user = await requireUserOrApiKeyWithOrg(c);
  const id = c.req.param("id");
  if (!id) return c.json({ success: false, error: "Missing app id" }, 400);

  const existing = await appsService.getById(id);
  if (!existing) return c.json({ success: false, error: "App not found" }, 404);
  if (existing.organization_id !== user.organization_id) {
    return c.json({ success: false, error: "Access denied" }, 403);
  }

  const rawBody = await c.req.json();
  const validationResult = UpdateAppSchema.safeParse(rawBody);
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

  const updateData = {
    ...validationResult.data,
    app_url: validationResult.data.app_url ?? undefined,
  };
  const updated = await appsService.update(id, updateData);

  logger.info(`[Apps API] ${verb === "PUT" ? "Updated" : "Patched"} app: ${id}`, {
    appId: id,
    userId: user.id,
    organizationId: user.organization_id,
    fields: Object.keys(validationResult.data),
  });

  return c.json({
    success: true,
    app: updated ? await appsService.withDatabaseState(updated) : updated,
  });
}

app.put("/", async (c) => {
  try {
    return await updateApp(c, "PUT");
  } catch (error) {
    logger.error("[Apps API] Failed to update app:", error);
    return failureResponse(c, error);
  }
});

app.patch("/", async (c) => {
  try {
    return await updateApp(c, "PATCH");
  } catch (error) {
    logger.error("[Apps API] Failed to patch app:", error);
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ success: false, error: "Missing app id" }, 400);

    const existing = await appsService.getById(id);
    if (!existing) return c.json({ success: false, error: "App not found" }, 404);
    if (existing.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const deleteGitHubRepo = c.req.query("deleteGitHubRepo") !== "false";

    const cleanupResult = await appCleanupService.deleteAppWithCleanup(id, {
      deleteGitHubRepo,
      continueOnError: true,
    });

    logger.info(`[Apps API] Deleted app with cleanup: ${id}`, {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
      cleaned: cleanupResult.cleaned,
      errors: cleanupResult.errors,
    });

    return c.json({
      success: cleanupResult.success,
      message: cleanupResult.success
        ? "App deleted successfully with all resources cleaned up"
        : "App deleted with some cleanup errors",
      cleaned: cleanupResult.cleaned,
      errors: cleanupResult.errors.length > 0 ? cleanupResult.errors : undefined,
    });
  } catch (error) {
    logger.error("[Apps API] Failed to delete app:", error);
    return failureResponse(c, error);
  }
});

export default app;
