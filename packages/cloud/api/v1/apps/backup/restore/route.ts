/**
 * App config restore (import).
 *
 * POST /api/v1/apps/backup/restore  { backup, name? }
 *
 * Creates a NEW app in the caller's org from a backup snapshot (new slug + new
 * API key) and reapplies its monetization + config. The returned api key is
 * shown once.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { type AppBackup, appBackupService } from "@/lib/services/app-backup";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const BackupSchema = z
  .object({
    version: z.number(),
    app: z.object({
      name: z.string().min(1),
      description: z.string().nullable().optional(),
      app_url: z.string(),
      allowed_origins: z.array(z.string()).optional().default([]),
      logo_url: z.string().nullable().optional(),
      website_url: z.string().nullable().optional(),
      contact_email: z.string().nullable().optional(),
      linked_character_ids: z.array(z.string()).optional().default([]),
    }),
    monetization: z.object({
      enabled: z.boolean(),
      inference_markup_percentage: z.number(),
      purchase_share_percentage: z.number(),
    }),
  })
  .passthrough();

const RestoreSchema = z.object({
  backup: BackupSchema,
  name: z.string().min(1).max(100).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const parsed = RestoreSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid backup",
          details: parsed.error.flatten(),
        },
        400,
      );
    }

    const { app: restored, apiKey } = await appBackupService.restoreApp(
      user.organization_id,
      user.id,
      parsed.data.backup as unknown as AppBackup,
      parsed.data.name,
    );
    logger.info("[App Backup API] restored app", { appId: restored.id });
    return c.json(
      {
        success: true,
        app: { id: restored.id, name: restored.name, slug: restored.slug },
        apiKey,
      },
      201,
    );
  } catch (error) {
    logger.error("[App Backup API] restore failed:", error);
    return failureResponse(c, error);
  }
});

export default app;
