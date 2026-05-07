import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { dbRead } from "@/db/client";
import { type UserIdentity, userIdentities } from "@/db/schemas/user-identities";
import { type User, users } from "@/db/schemas/users";
import { failureResponse, jsonError } from "@/lib/api/cloud-worker-errors";
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const identityProviderSchema = z.enum([
  "steward",
  "telegram",
  "discord",
  "whatsapp",
  "phone",
]);

const resolveIdentitySchema = z.object({
  identifier: z.string().trim().min(1),
  provider: identityProviderSchema.optional(),
});

type IdentityProvider = z.infer<typeof identityProviderSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

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

async function findIdentityByProvider(
  provider: IdentityProvider,
  identifier: string,
): Promise<UserIdentity | undefined> {
  switch (provider) {
    case "steward":
      return dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.steward_user_id, identifier),
      });
    case "telegram":
      return dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.telegram_id, identifier),
      });
    case "discord":
      return dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.discord_id, identifier),
      });
    case "whatsapp":
      return dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.whatsapp_id, identifier),
      });
    case "phone":
      return dbRead.query.userIdentities.findFirst({
        where: eq(userIdentities.phone_number, identifier),
      });
  }
}

async function findFirstIdentity(identifier: string): Promise<UserIdentity | undefined> {
  const providers: IdentityProvider[] = ["steward", "telegram", "discord", "whatsapp"];
  for (const provider of providers) {
    const identity = await findIdentityByProvider(provider, identifier);
    if (identity) return identity;
  }
  return findIdentityByProvider("phone", identifier);
}

async function loadUserAndIdentity(
  identifier: string,
  provider?: IdentityProvider,
): Promise<{ user: User; identity?: UserIdentity } | null> {
  if (provider) {
    const identity = await findIdentityByProvider(provider, identifier);
    if (!identity) return null;
    const user = await dbRead.query.users.findFirst({ where: eq(users.id, identity.user_id) });
    return user ? { user, identity } : null;
  }

  let user: User | undefined;
  if (UUID_RE.test(identifier)) {
    user = await dbRead.query.users.findFirst({ where: eq(users.id, identifier) });
  } else if (identifier.includes("@")) {
    user = await dbRead.query.users.findFirst({
      where: eq(users.email, identifier.toLowerCase()),
    });
  } else if (EVM_ADDRESS_RE.test(identifier)) {
    user = await dbRead.query.users.findFirst({
      where: eq(users.wallet_address, identifier.toLowerCase()),
    });
  }

  if (user) {
    const identity = await dbRead.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, user.id),
    });
    return { user, identity };
  }

  const identity = await findFirstIdentity(identifier);
  if (!identity) return null;

  user = await dbRead.query.users.findFirst({ where: eq(users.id, identity.user_id) });
  return user ? { user, identity } : null;
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
    const result = await loadUserAndIdentity(parsed.identifier, parsed.provider);
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
