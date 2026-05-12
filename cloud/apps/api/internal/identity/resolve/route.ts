import { Hono } from "hono";
import { z } from "zod";
import { type IdentityProvider, usersRepository } from "@/db/repositories/users";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const identityProviderSchema = z.enum(["steward", "telegram", "discord", "whatsapp", "phone"]);

const resolveIdentitySchema = z.object({
  identifier: z.string().trim().min(1),
  provider: identityProviderSchema.optional(),
});

const app = new Hono<AppEnv>();

function getInternalBearer(c: AppContext): string | null {
  const auth = c.req.header("authorization");
  if (!auth?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return auth.slice(7).trim();
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function requireInternalSecret(c: AppContext): Response | null {
  const expected = ((c.env.INTERNAL_SECRET as string | undefined) ?? "").trim();
  if (!expected) {
    return jsonError(c, 503, "Internal auth not configured", "internal_error");
  }

  const provided = getInternalBearer(c) ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return jsonError(c, 401, "Unauthorized", "authentication_required");
  }

  return null;
}

app.post("/", async (c) => {
  try {
    const authFailure = requireInternalSecret(c);
    if (authFailure) return authFailure;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "validation_error");
    }

    const parsed = resolveIdentitySchema.parse(rawBody);
    const result = await usersRepository.resolveIdentity(
      parsed.identifier,
      parsed.provider as IdentityProvider | undefined,
    );
    if (!result) {
      return jsonError(c, 404, "Identity not found", "resource_not_found");
    }

    const { user, identity } = result;
    return c.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          organizationId: user.organization_id,
          role: user.role,
          walletAddress: user.wallet_address,
          stewardUserId: user.steward_user_id,
          isActive: user.is_active,
        },
        identity: identity
          ? {
              stewardUserId: identity.steward_user_id,
              telegramId: identity.telegram_id,
              discordId: identity.discord_id,
              whatsappId: identity.whatsapp_id,
              phoneNumber: identity.phone_number,
              isAnonymous: identity.is_anonymous,
            }
          : null,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

export default app;
