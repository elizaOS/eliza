/**
 * GET /api/v1/apps/:id/database  - the app's database mode + current binding
 * PUT /api/v1/apps/:id/database  - set the mode ("none" | "isolated")
 *
 * The mode is stored on `apps.metadata.databaseMode` and read by the deploy
 * orchestrator. Setting it is side-effect-free + Worker-safe (no `pg`): the DB
 * is materialized (or stops being injected) on the NEXT deploy.
 *   - "none"     -> stateless app, no DATABASE_URL.
 *   - "isolated" -> the app's OWN isolated per-tenant Postgres, injected as
 *                   DATABASE_URL + POSTGRES_URL on deploy.
 * Add a DB to a stateless app later by PUTting "isolated" then redeploying — the
 * provision is create-if-not-exists, so it materializes with no data loss; the
 * inverse (isolated -> none) stops injecting the DSN but leaves the DB intact.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { isAppKeyOutOfScope } from "@/lib/auth/app-key-scope";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  type AppDatabaseMode,
  resolveAppDatabaseMode,
} from "@/lib/services/app-database-mode";
import { appsService } from "@/lib/services/apps";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

const PutSchema = z.object({
  mode: z.enum(["none", "isolated"]),
});

async function loadOwnedApp(c: AppContext) {
  const user = await requireUserOrApiKeyWithOrg(c);
  const appId = c.req.param("id");
  if (!appId) return { error: "missing app id", status: 400 as const };
  const appRow = await appsService.getById(appId);
  if (!appRow || appRow.organization_id !== user.organization_id) {
    return { error: "App not found", status: 404 as const };
  }
  if (await isAppKeyOutOfScope(c.get("apiKeyId"), appId)) {
    return { error: "Access denied", status: 403 as const };
  }
  return { appRow, appId };
}

/** The deployed container is the live binding; metadata carries the chosen mode. */
function describe(metadata: Record<string, unknown> | null | undefined) {
  const mode: AppDatabaseMode = resolveAppDatabaseMode(metadata);
  return {
    mode,
    hasIsolatedDatabase: mode === "isolated",
    // Whether a deploy has happened (so the caller knows a redeploy is needed for
    // a just-changed mode to take effect).
    deployedContainerId:
      typeof metadata?.containerId === "string"
        ? (metadata.containerId as string)
        : null,
  };
}

app.get("/", async (c) => {
  const loaded = await loadOwnedApp(c);
  if ("error" in loaded) {
    return c.json({ success: false, error: loaded.error }, loaded.status);
  }
  return c.json({
    success: true,
    data: describe(loaded.appRow.metadata as Record<string, unknown>),
  });
});

app.put("/", async (c) => {
  const loaded = await loadOwnedApp(c);
  if ("error" in loaded) {
    return c.json({ success: false, error: loaded.error }, loaded.status);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { success: false, error: "mode must be 'none' or 'isolated'" },
      400,
    );
  }
  const nextMode = parsed.data.mode;

  try {
    const existingMeta =
      (loaded.appRow.metadata as Record<string, unknown>) ?? {};
    const prevMode = resolveAppDatabaseMode(existingMeta);
    await appsService.update(loaded.appId, {
      metadata: { ...existingMeta, databaseMode: nextMode },
    });
    return c.json({
      success: true,
      data: {
        mode: nextMode,
        changed: prevMode !== nextMode,
        // Side-effect-free: the change applies on the next deploy.
        appliesOnNextDeploy: true,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
