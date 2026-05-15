import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { dbRead } from "@/db/helpers";
import {
  type IdentityProvider,
  usersRepository,
} from "@/db/repositories/users";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import type { AppEnv } from "@/types/cloud-worker-env";
import { requireInternalAuth } from "../../_auth";

const identityProviderSchema = z.enum([
  "steward",
  "telegram",
  "discord",
  "whatsapp",
  "phone",
]);

const resolveIdentitySchema = z
  .object({
    identifier: z.string().trim().min(1).optional(),
    provider: identityProviderSchema.optional(),
    platform: z.string().trim().min(1).optional(),
    platformId: z.string().trim().min(1).optional(),
    platformName: z.string().trim().optional(),
  })
  .refine((value) => value.identifier || value.platformId, {
    message: "identifier or platformId is required",
  });

const app = new Hono<AppEnv>();

function providerForPlatform(
  platform: string | undefined,
): IdentityProvider | undefined {
  switch (platform) {
    case "telegram":
      return "telegram";
    case "discord":
      return "discord";
    case "whatsapp":
      return "whatsapp";
    case "twilio":
    case "blooio":
      return "phone";
    default:
      return undefined;
  }
}

app.post("/", async (c) => {
  try {
    const auth = await requireInternalAuth(c);
    if (auth instanceof Response) return auth;

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return jsonError(c, 400, "Invalid JSON body", "validation_error");
    }

    const parsed = resolveIdentitySchema.parse(rawBody);
    const identifier = parsed.platformId ?? parsed.identifier;
    if (!identifier) {
      return jsonError(
        c,
        400,
        "identifier or platformId is required",
        "validation_error",
      );
    }
    const provider =
      (parsed.provider as IdentityProvider | undefined) ??
      providerForPlatform(parsed.platform);
    const result = await usersRepository.resolveIdentity(identifier, provider);
    if (!result) {
      return jsonError(c, 404, "Identity not found", "resource_not_found");
    }

    const { user, identity } = result;
    const organizationId = user.organization_id;
    if (!organizationId) {
      return jsonError(
        c,
        404,
        "Provisioned agent not found",
        "resource_not_found",
      );
    }

    const [sandbox] = await dbRead
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.organization_id, organizationId))
      .orderBy(desc(agentSandboxes.created_at))
      .limit(1);

    return c.json({
      success: true,
      userId: user.id,
      organizationId,
      agentId: sandbox?.id ?? null,
      data: {
        user: {
          id: user.id,
          email: user.email,
          organizationId,
          role: user.role,
          walletAddress: user.wallet_address,
          stewardUserId: user.steward_user_id,
          isActive: user.is_active,
        },
        agent: sandbox
          ? {
              id: sandbox.id,
              status: sandbox.status,
            }
          : null,
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
