/**
 * POST /api/v1/x/posts
 * Create a tweet for the authenticated org. Requires explicit confirmPost
 * (or legacy confirmSend). Optional reply / quote target.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { createXPost } from "@/lib/services/x";
import type { AppEnv } from "@/types/cloud-worker-env";
import { xRouteErrorResponse } from "../error-response";

const requestSchema = z
  .object({
    confirmPost: z.literal(true).optional(),
    confirmSend: z.literal(true).optional(),
    connectionRole: z.enum(["owner", "agent"]).optional(),
    text: z.string().trim().min(1).max(280),
    replyToTweetId: z.string().regex(/^\d+$/).optional(),
    quoteTweetId: z.string().regex(/^\d+$/).optional(),
  })
  .refine((value) => value.confirmPost === true || value.confirmSend === true, {
    message: "X posting requires explicit confirmation",
    path: ["confirmPost"],
  });

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Request body must be valid JSON" }, 400);
    }

    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: "Invalid X post request",
          details: parsed.error.issues,
        },
        400,
      );
    }

    const result = await createXPost({
      organizationId: user.organization_id,
      connectionRole: parsed.data.connectionRole,
      text: parsed.data.text,
      replyToTweetId: parsed.data.replyToTweetId,
      quoteTweetId: parsed.data.quoteTweetId,
    });
    return c.json({ success: true, ...result });
  } catch (error) {
    return xRouteErrorResponse(c, error);
  }
});

export default app;
