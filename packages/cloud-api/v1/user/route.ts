/**
 * GET   /api/v1/user — current user's profile + organization summary.
 * PATCH /api/v1/user — update profile fields.
 */

import { Hono } from "hono";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKey } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { usersService } from "@/lib/services/users";
import type {
  CurrentUserDto,
  CurrentUserOrganizationDto,
  CurrentUserResponse,
  UpdatedUserDto,
  UpdatedUserResponse,
} from "@/lib/types/cloud-api";
import type { AppEnv } from "@/types/cloud-worker-env";

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  avatar: z.string().url().optional().or(z.literal("")),
  nickname: z.string().max(50).optional(),
  work_function: z
    .enum(["developer", "designer", "product", "data", "marketing", "sales", "other"])
    .optional(),
  preferences: z.string().max(1000).optional(),
  response_notifications: z.boolean().optional(),
  email_notifications: z.boolean().optional(),
});

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

type UserWithOrganization = NonNullable<
  Awaited<ReturnType<typeof usersService.getWithOrganization>>
>;
type UpdatedUser = NonNullable<Awaited<ReturnType<typeof usersService.update>>>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}

function toOrganizationDto(
  organization: UserWithOrganization["organization"],
): CurrentUserOrganizationDto | null {
  if (!organization) return null;

  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    credit_balance: organization.credit_balance,
    billing_email: organization.billing_email,
    is_active: organization.is_active,
    created_at: toIsoString(organization.created_at),
    updated_at: toIsoString(organization.updated_at),
  };
}

function toUpdatedUserDto(user: UpdatedUser): UpdatedUserDto {
  return {
    id: user.id,
    email: user.email,
    email_verified: user.email_verified,
    wallet_address: user.wallet_address,
    wallet_chain_type: user.wallet_chain_type,
    wallet_verified: user.wallet_verified,
    name: user.name,
    avatar: user.avatar,
    organization_id: user.organization_id,
    role: user.role,
    steward_user_id: user.steward_user_id,
    telegram_id: user.telegram_id,
    telegram_username: user.telegram_username,
    telegram_first_name: user.telegram_first_name,
    telegram_photo_url: user.telegram_photo_url,
    discord_id: user.discord_id,
    discord_username: user.discord_username,
    discord_global_name: user.discord_global_name,
    discord_avatar_url: user.discord_avatar_url,
    whatsapp_id: user.whatsapp_id,
    whatsapp_name: user.whatsapp_name,
    phone_number: user.phone_number,
    phone_verified: user.phone_verified,
    is_anonymous: user.is_anonymous,
    anonymous_session_id: user.anonymous_session_id,
    expires_at: toIsoStringOrNull(user.expires_at),
    nickname: user.nickname,
    work_function: user.work_function,
    preferences: user.preferences,
    email_notifications: user.email_notifications,
    response_notifications: user.response_notifications,
    is_active: user.is_active,
    created_at: toIsoString(user.created_at),
    updated_at: toIsoString(user.updated_at),
  };
}

function toCurrentUserDto(user: UserWithOrganization): CurrentUserDto {
  return {
    ...toUpdatedUserDto(user),
    organization: toOrganizationDto(user.organization),
  };
}

app.get("/", async (c) => {
  const authed = await requireUserOrApiKey(c);
  const user = await usersService.getWithOrganization(authed.id);
  if (!user) throw NotFoundError("User not found");

  const data = toCurrentUserDto(user);
  const response: CurrentUserResponse = {
    success: true,
    data,
  };

  return c.json({ ...data, ...response });
});

app.patch("/", async (c) => {
  const authed = await requireUserOrApiKey(c);
  const body = await c.req.json().catch(() => {
    throw ValidationError("Invalid JSON");
  });
  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    throw ValidationError("Validation error", { issues: parsed.error.issues });
  }
  const validated = parsed.data;

  const updated = await usersService.update(authed.id, {
    ...(validated.name && { name: validated.name }),
    ...(validated.avatar !== undefined && { avatar: validated.avatar || null }),
    ...(validated.nickname !== undefined && { nickname: validated.nickname }),
    ...(validated.work_function !== undefined && { work_function: validated.work_function }),
    ...(validated.preferences !== undefined && { preferences: validated.preferences }),
    ...(validated.response_notifications !== undefined && {
      response_notifications: validated.response_notifications,
    }),
    ...(validated.email_notifications !== undefined && {
      email_notifications: validated.email_notifications,
    }),
  });

  if (!updated) throw NotFoundError("User not found");

  const response: UpdatedUserResponse = {
    success: true,
    data: toUpdatedUserDto(updated),
    message: "Profile updated successfully",
  };

  return c.json(response);
});

export default app;
