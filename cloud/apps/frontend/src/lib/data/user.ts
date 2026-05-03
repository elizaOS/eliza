/**
 * Current-user data hook backed by `GET /api/v1/user`.
 *
 * This module calls the profile route used by account, settings, billing,
 * and invoice pages: `GET /api/v1/user`. It unwraps the `{ success, data }`
 * envelope and adapts the payload to the `UserWithOrganization` shape that
 * the dashboard components consume directly.
 */
import { useQuery } from "@tanstack/react-query";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import type { CurrentUserDto, CurrentUserResponse } from "@/lib/types/cloud-api";
import { ApiError, api } from "../api-client";

/**
 * Adapted `UserWithOrganization`-compatible record used by the
 * dashboard components (account, settings, billing, invoices). Date
 * columns are returned as `Date` so consumers that call
 * `formatDate(user.created_at)` work without changes.
 *
 * The API returns the user identity fields directly; this adapter only converts
 * timestamp strings into Date objects for existing dashboard components.
 */
export interface UserProfile {
  id: string;
  email: string | null;
  email_verified: boolean | null;
  wallet_address: string | null;
  wallet_chain_type: string | null;
  wallet_verified: boolean;
  name: string | null;
  avatar: string | null;
  organization_id: string | null;
  role: string;
  steward_user_id: string | null;
  telegram_id: string | null;
  telegram_username: string | null;
  telegram_first_name: string | null;
  telegram_photo_url: string | null;
  discord_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  discord_avatar_url: string | null;
  whatsapp_id: string | null;
  whatsapp_name: string | null;
  phone_number: string | null;
  phone_verified: boolean | null;
  is_anonymous: boolean;
  anonymous_session_id: string | null;
  expires_at: Date | null;
  nickname: string | null;
  work_function: string | null;
  preferences: string | null;
  email_notifications: boolean | null;
  response_notifications: boolean | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  organization: {
    id: string;
    name: string | null;
    slug: string | null;
    billing_email: string | null;
    credit_balance: string;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  } | null;
}

function adapt(payload: CurrentUserDto): UserProfile {
  const created = new Date(payload.created_at);
  const updated = new Date(payload.updated_at);
  const org = payload.organization;
  return {
    id: payload.id,
    email: payload.email,
    email_verified: payload.email_verified,
    wallet_address: payload.wallet_address,
    wallet_chain_type: payload.wallet_chain_type,
    wallet_verified: payload.wallet_verified,
    name: payload.name,
    avatar: payload.avatar,
    organization_id: payload.organization_id,
    role: payload.role,
    steward_user_id: payload.steward_user_id,
    telegram_id: payload.telegram_id,
    telegram_username: payload.telegram_username,
    telegram_first_name: payload.telegram_first_name,
    telegram_photo_url: payload.telegram_photo_url,
    discord_id: payload.discord_id,
    discord_username: payload.discord_username,
    discord_global_name: payload.discord_global_name,
    discord_avatar_url: payload.discord_avatar_url,
    whatsapp_id: payload.whatsapp_id,
    whatsapp_name: payload.whatsapp_name,
    phone_number: payload.phone_number,
    phone_verified: payload.phone_verified,
    is_anonymous: payload.is_anonymous,
    anonymous_session_id: payload.anonymous_session_id,
    expires_at: payload.expires_at ? new Date(payload.expires_at) : null,
    nickname: payload.nickname,
    work_function: payload.work_function,
    preferences: payload.preferences,
    email_notifications: payload.email_notifications,
    response_notifications: payload.response_notifications,
    is_active: payload.is_active,
    created_at: created,
    updated_at: updated,
    organization: org
      ? {
          id: org.id,
          name: org.name,
          slug: org.slug,
          billing_email: org.billing_email,
          credit_balance: org.credit_balance,
          is_active: org.is_active,
          created_at: new Date(org.created_at),
          updated_at: new Date(org.updated_at),
        }
      : null,
  };
}

/**
 * Returns the current user's profile + organization summary, gated on
 * the synchronous session check so we do not fire a network request
 * before the session is restored from storage.
 */
export function useUserProfile() {
  const session = useSessionAuth();
  const enabled = session.ready && session.authenticated;

  const query = useQuery({
    queryKey: ["user-profile", session.user?.id ?? null],
    queryFn: async () => {
      const res = await api<CurrentUserResponse>("/api/v1/user");
      return adapt(res.data);
    },
    enabled,
  });

  return {
    ...query,
    user: query.data ?? null,
    isAuthenticated: session.authenticated,
    isReady: session.ready,
  };
}

export { ApiError };
