/**
 * App config backup (export).
 *
 * GET /api/v1/apps/:id/backup — download a portable, secret-free config snapshot
 * of the app (recreate it later via POST /api/v1/apps/backup/restore).
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { appBackupService } from "@/lib/services/app-backup";
import { appsService } from "@/lib/services/apps";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

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
    // An app-scoped API key may only act on its own app, never a sibling (#10852).
    if (await isAppKeyOutOfScope(c.get("apiKeyId"), id)) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    const backup = await appBackupService.exportApp(found);
    return c.json({ success: true, backup });
  } catch (error) {
    logger.error("[App Backup API] export failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
