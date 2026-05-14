import { Hono } from "hono";
import { z } from "zod";
import { type IdentityProvider, usersRepository } from "@/db/repositories/users";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import { ensureElizaAppProvisioning } from "@/lib/services/eliza-app/provisioning";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const identityProviderSchema = z.enum([
  "steward",
  "telegram",
  "discord",
  "whatsapp",
  "phone",
  "twilio",
  "blooio",
]);

const resolveIdentitySchema = z.object({
  identifier: z.string().trim().min(1).optional(),
  platformId: z.string().trim().min(1).optional(),
  provider: identityProviderSchema.optional(),
  platform: identityProviderSchema.optional(),
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

function toIdentityProvider(provider: z.infer<typeof identityProviderSchema> | undefined) {
  if (provider === "twilio" || provider === "blooio") return "phone";
  return provider;
}

async function resolveIdentity(c: AppContext, rawInput: unknown) {
  try {
    const authFailure = requireInternalSecret(c);
    if (authFailure) return authFailure;

    const parsed = resolveIdentitySchema.parse(rawInput);
    const identifier = parsed.identifier ?? parsed.platformId;
    if (!identifier) {
      return jsonError(c, 400, "identifier is required", "validation_error");
    }
    const provider = toIdentityProvider(parsed.provider ?? parsed.platform) as
      | IdentityProvider
      | undefined;
    const result = await usersRepository.resolveIdentity(
      identifier,
      provider,
    );
    if (!result) {
      return jsonError(c, 404, "Identity not found", "resource_not_found");
    }

    const { user, identity } = result;
    if (!user.organization_id) {
      return jsonError(c, 404, "User organization not found", "resource_not_found");
    }

    const provisioning = await ensureElizaAppProvisioning({
      userId: user.id,
      organizationId: user.organization_id,
    });

    return c.json({
      success: true,
      userId: user.id,
      organizationId: user.organization_id,
      agentId: provisioning.agentId,
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
        agent: provisioning.agentId
          ? {
              id: provisioning.agentId,
              status: provisioning.status,
              bridgeUrl: provisioning.bridgeUrl,
            }
          : null,
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
}

app.get("/", async (c) => {
  return resolveIdentity(c, {
    platform: c.req.query("platform") ?? c.req.query("provider") ?? undefined,
    platformId: c.req.query("platformId") ?? undefined,
    identifier: c.req.query("identifier") ?? undefined,
  });
});

app.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body", "validation_error");
  }

  return resolveIdentity(c, rawBody);
});

export default app;
