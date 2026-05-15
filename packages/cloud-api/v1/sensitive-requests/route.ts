/**
 * Cloud sensitive request links.
 *
 * Creates durable, authenticated request records for values that must not be
 * collected in public chat.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type SensitiveRequestActor,
  sensitiveRequestsService,
} from "@/lib/services/sensitive-requests";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const SecretTargetSchema = z.object({
  kind: z.literal("secret"),
  key: z.string().trim().min(1).max(256),
  scope: z.enum(["global", "world", "user", "agent", "app"]).optional(),
  appId: z.string().optional(),
  validation: z
    .object({
      type: z.enum(["none", "non_empty", "url", "regex"]),
      pattern: z.string().optional(),
    })
    .optional(),
});

const PrivateInfoTargetSchema = z.object({
  kind: z.literal("private_info"),
  fields: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(128),
        label: z.string().optional(),
        required: z.boolean().optional(),
        classification: z.enum(["private", "public_non_secret"]).optional(),
      }),
    )
    .min(1)
    .max(50),
  storage: z
    .object({
      kind: z.enum(["app_metadata", "profile", "workflow_input", "custom"]),
      key: z.string().optional(),
    })
    .optional(),
});

const CreateSensitiveRequestSchema = z.object({
  kind: z.enum(["secret", "private_info"]),
  agentId: z.string().trim().min(1).max(256),
  ownerEntityId: z.string().optional(),
  requesterEntityId: z.string().optional(),
  sourceRoomId: z.string().optional(),
  sourceChannelType: z.string().optional(),
  sourcePlatform: z.string().optional(),
  target: z.discriminatedUnion("kind", [SecretTargetSchema, PrivateInfoTargetSchema]),
  policy: z.record(z.string(), z.unknown()).optional(),
  delivery: z.record(z.string(), z.unknown()).optional(),
  callback: z.record(z.string(), z.unknown()).optional(),
  lifetimeSeconds: z
    .number()
    .int()
    .min(60)
    .max(7 * 24 * 60 * 60)
    .optional(),
});

function actorFromContext(
  c: Parameters<typeof requireUserOrApiKeyWithOrg>[0],
  user: Awaited<ReturnType<typeof requireUserOrApiKeyWithOrg>>,
): SensitiveRequestActor {
  return {
    type: c.get("authMethod") === "api_key" ? "api_key" : "user",
    userId: user.id,
    organizationId: user.organization_id,
    email: user.email,
  };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSensitiveRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { success: false, error: "Invalid request", details: parsed.error.issues },
        400,
      );
    }

    const result = await sensitiveRequestsService.create(
      {
        ...parsed.data,
        organizationId: user.organization_id,
      },
      actorFromContext(c, user),
    );

    return c.json({ success: true, ...result }, 201);
  } catch (error) {
    logger.error("[SensitiveRequests API] create failed", { error });
    return failureResponse(c, error);
  }
});

export default app;
