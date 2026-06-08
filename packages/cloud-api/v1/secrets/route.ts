/**
 * GET /api/v1/secrets — list secrets for the authenticated user's organization.
 * POST /api/v1/secrets — create or upsert a new provider secret.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireApiKeyPermission } from "@/api-app/middleware/auth";
import { secretsRepository } from "@/db/repositories/secrets";
import type { SecretProvider } from "@/db/schemas/secrets";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
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

const createSecretSchema = z.object({
  name: z.string().trim().min(1).max(250),
  provider: z.enum(providersList).default("custom"),
  value: z.string().min(1).max(65536),
  description: z.string().trim().max(1000).optional(),
});

app.get("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const secretsMetadata = await secretsService.list(user.organization_id);
    return c.json({ secrets: secretsMetadata });
  } catch (error) {
    logger.error("[Secrets API] Error listing secrets:", error);
    return failureResponse(c, error);
  }
});

app.post("/", async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    const body = await c.req.json();
    const { name, provider, value, description } =
      createSecretSchema.parse(body);

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

    const existing = await secretsRepository.findByName(
      user.organization_id,
      name,
    );
    if (existing) {
      const updated = await secretsService.update(
        existing.id,
        user.organization_id,
        {
          value,
          description,
          provider: provider as SecretProvider,
        },
        audit,
      );
      return c.json({ secret: updated });
    }

    const created = await secretsService.create(
      {
        organizationId: user.organization_id,
        name,
        value,
        provider: provider as SecretProvider,
        description,
        createdBy: user.id,
      },
      audit,
    );

    return c.json({ secret: created }, 201);
  } catch (error) {
    logger.error("[Secrets API] Error creating/upserting secret:", error);
    if (error instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: error.issues }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
