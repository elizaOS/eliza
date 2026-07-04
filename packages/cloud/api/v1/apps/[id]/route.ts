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
import type { NewApp } from "@/db/schemas/apps";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appCleanupService } from "@/lib/services/app-cleanup";
import { buildReviewCandidate } from "@/lib/services/app-review";
import { appsService } from "@/lib/services/apps";
import { charactersService } from "@/lib/services/characters/characters";
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
    // An app-scoped API key may only read its own app, never a sibling's raw
    // row (metadata, api_key_id, review state, automation config) (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    return c.json({
      success: true,
      app: await appsService.withDatabaseState(found),
    });
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
  // An app-scoped API key may only act on its own app, never a sibling (#10852).
  if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
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

  // SECURITY: linked_character_ids on the generic update path must enforce the
  // SAME ownership guard the dedicated PUT /apps/:id/characters route does —
  // otherwise a caller can link another org's PRIVATE character id and read its
  // metadata back via GET /apps/:id/characters (cross-tenant disclosure).
  if (validationResult.data.linked_character_ids) {
    for (const characterId of validationResult.data.linked_character_ids) {
      const character = await charactersService.getById(characterId);
      if (!character) {
        return c.json(
          { success: false, error: `Character not found: ${characterId}` },
          404,
        );
      }
      if (character.user_id !== user.id && !character.is_public) {
        return c.json(
          {
            success: false,
            error: `Not authorized to link character: ${characterId}`,
          },
          403,
        );
      }
    }
  }

  const updateData: Partial<NewApp> = {
    ...validationResult.data,
    app_url: validationResult.data.app_url ?? undefined,
  };

  // Re-review on material change (#10732): if a review-relevant field changed on
  // an app that went through the automated review (has a snapshot hash), drop it
  // back to `draft` so it must be re-submitted before it can keep monetizing.
  // Grandfathered apps without a hash keep their compatibility approval. (Enforcement is
  // airtight regardless via the content-hash check in isAppMonetizationApproved.)
  //
  // DECISION (explicit, not an accident): resetting review_status blocks NEW
  // paid charges and re-enabling monetization immediately, but already-flowing
  // inference-markup earnings are NOT cut off — they keep accruing until the
  // re-review lands (grandfather-style). Rationale: markup rides existing usage
  // of an app that previously passed review; hard-stopping it on every metadata
  // edit would let a rename freeze a creator's live revenue. A rejected
  // re-review DOES cut everything off.
  if (existing.review_status === "approved" && existing.review_content_hash) {
    const nextHash = buildReviewCandidate({
      name: updateData.name ?? existing.name,
      description: updateData.description ?? existing.description,
      app_url: updateData.app_url ?? existing.app_url,
      website_url: updateData.website_url ?? existing.website_url,
      metadata: existing.metadata,
    }).contentHash;
    if (nextHash !== existing.review_content_hash) {
      updateData.review_status = "draft";
      updateData.review_content_hash = null;
    }
  }

  const updated = await appsService.update(id, updateData);

  logger.info(
    `[Apps API] ${verb === "PUT" ? "Updated" : "Patched"} app: ${id}`,
    {
      appId: id,
      userId: user.id,
      organizationId: user.organization_id,
      fields: Object.keys(validationResult.data),
    },
  );

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
    if (!existing)
      return c.json({ success: false, error: "App not found" }, 404);
    if (existing.organization_id !== user.organization_id) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
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
      errors:
        cleanupResult.errors.length > 0 ? cleanupResult.errors : undefined,
    });
  } catch (error) {
    logger.error("[Apps API] Failed to delete app:", error);
    return failureResponse(c, error);
  }
});

export default app;
