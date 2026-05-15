/**
 * Eliza App - WhatsApp Authentication Endpoint
 *
 * Links a WhatsApp identity to an existing Eliza App session.
 * Direct sign-in via `whatsapp_id` alone is intentionally disabled because
 * a WhatsApp ID is a phone-number-derived identifier and not secure proof
 * that the caller controls the account.
 *
 * POST /api/eliza-app/auth/whatsapp
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  elizaAppSessionService,
  elizaAppUserService,
  type ValidatedSession,
} from "@/lib/services/eliza-app";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const whatsappAuthSchema = z.object({
  whatsapp_id: z
    .string()
    .min(7, "WhatsApp ID must be at least 7 digits")
    .max(15, "WhatsApp ID must be at most 15 digits")
    .regex(/^\d+$/, "WhatsApp ID must contain only digits"),
});

export interface AuthSuccessResponse {
  success: true;
  user: {
    id: string;
    whatsapp_id: string;
    whatsapp_name: string | null;
    phone_number: string | null;
    name: string | null;
    organization_id: string;
  };
  session: {
    token: string;
    expires_at: string;
  };
}

export interface AuthErrorResponse {
  success: false;
  error: string;
  code: string;
}

async function handleWhatsAppAuth(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  const parseResult = whatsappAuthSchema.safeParse(body);
  if (!parseResult.success) {
    return Response.json(
      {
        success: false,
        error: "Invalid request body",
        code: "INVALID_REQUEST",
      },
      { status: 400 },
    );
  }

  const { whatsapp_id: whatsappId } = parseResult.data;
  const authHeader = request.headers.get("authorization");
  let existingSession: ValidatedSession | null = null;
  if (authHeader) {
    existingSession = await elizaAppSessionService.validateAuthHeader(authHeader);
  }

  if (!existingSession) {
    return Response.json(
      {
        success: false,
        error: "WhatsApp linking requires an existing authenticated session",
        code: "AUTH_PROOF_REQUIRED",
      },
      { status: 403 },
    );
  }

  logger.info("[ElizaApp WhatsAppAuth] Session-based linking detected", {
    existingUserId: existingSession.userId,
  });

  const linkResult = await elizaAppUserService.linkWhatsAppToUser(existingSession.userId, {
    whatsappId,
  });

  if (!linkResult.success) {
    return Response.json(
      {
        success: false,
        error: linkResult.error || "This WhatsApp account is already linked to another account",
        code: "WHATSAPP_ALREADY_LINKED",
      },
      { status: 409 },
    );
  }

  const updatedUser = await elizaAppUserService.getById(existingSession.userId);
  if (!updatedUser || !updatedUser.organization) {
    return Response.json(
      {
        success: false,
        error: "User not found after linking",
        code: "INTERNAL_ERROR",
      },
      { status: 500 },
    );
  }

  const session = await elizaAppSessionService.createSession(
    updatedUser.id,
    updatedUser.organization.id,
    {
      whatsappId,
      phoneNumber: updatedUser.phone_number || undefined,
      ...(updatedUser.telegram_id && { telegramId: updatedUser.telegram_id }),
      ...(updatedUser.discord_id && { discordId: updatedUser.discord_id }),
    },
  );

  logger.info("[ElizaApp WhatsAppAuth] Session-based WhatsApp linking successful", {
    userId: updatedUser.id,
    whatsappId,
  });

  return Response.json({
    success: true,
    user: {
      id: updatedUser.id,
      whatsapp_id: updatedUser.whatsapp_id!,
      whatsapp_name: updatedUser.whatsapp_name,
      phone_number: updatedUser.phone_number,
      name: updatedUser.name,
      organization_id: updatedUser.organization.id,
    },
    session: {
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
    },
  });
}

async function __next_GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "eliza-app-whatsapp-auth",
    timestamp: new Date().toISOString(),
  });
}

const honoRouter = new Hono<AppEnv>();
honoRouter.get("/", async () => __next_GET());
honoRouter.post("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    return await handleWhatsAppAuth(c.req.raw);
  } catch (error) {
    return failureResponse(c, error);
  }
});
export default honoRouter;
