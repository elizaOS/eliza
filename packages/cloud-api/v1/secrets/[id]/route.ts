/**
 * PATCH  /api/v1/secrets/[id] — update an individual secret.
 * DELETE /api/v1/secrets/[id] — delete an individual secret.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireApiKeyPermission } from "@/api-app/middleware/auth";
import type { SecretProvider } from "@/db/schemas/secrets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import type { AuditContext } from "@/lib/services/secrets";
import { secretsService } from "@/lib/services/secrets";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));
app.use("*", requireApiKeyPermission("keys:write"));

const providersList = [
  "openai",
  "anthropic",
  "google",
  "elevenlabs",
  "fal",
  "stripe",
  "discord",
  "telegram",
  "twitter",
  "github",
  "slack",
  "aws",
  "custom",
] as const;

const updateSecretSchema = z.object({
  name: z.string().trim().min(1).max(250).optional(),
  provider: z.enum(providersList).optional(),
  value: z.string().min(1).max(65536).optional(),
  description: z.string().trim().max(1000).optional(),
});

app.patch("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const body = await c.req.json();
    const { name, provider, value, description } =
      updateSecretSchema.parse(body);

    const audit: AuditContext = {
      actorType: "user",
      actorId: user.id,
      actorEmail: user.email ?? undefined,
      ipAddress:
        c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
      userAgent: c.req.header("user-agent"),
      requestId: c.get("requestId"),
      endpoint: c.req.path,
    };

    try {
      const updated = await secretsService.update(
        id,
        user.organization_id,
        {
          name,
          provider: provider as SecretProvider,
          value,
          description,
        },
        audit,
      );
      return c.json({ secret: updated });
    } catch (err) {
      if (err instanceof Error && err.message === "Secret not found") {
        return c.json({ error: "Secret not found" }, 404);
      }
      throw err;
    }
  } catch (error) {
    logger.error("[Secrets API] Error updating secret:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

app.delete("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");
    if (!id) return c.json({ error: "Missing id" }, 400);

    const audit: AuditContext = {
      actorType: "user",
      actorId: user.id,
      actorEmail: user.email ?? undefined,
      ipAddress:
        c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for"),
      userAgent: c.req.header("user-agent"),
      requestId: c.get("requestId"),
      endpoint: c.req.path,
    };

    try {
      await secretsService.delete(id, user.organization_id, audit);
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof Error && err.message === "Secret not found") {
        return c.json({ error: "Secret not found" }, 404);
      }
      throw err;
    }
  } catch (error) {
    logger.error("[Secrets API] Error deleting secret:", error);
    return failureResponse(c, error);
  }
});

export default app;
