export const DEFAULT_LOGIN_RETURN_TO = "/dashboard/agents";
export const OAUTH_LOGIN_PENDING_STORAGE_KEY = "oauth_login_pending";
export const OAUTH_LOGIN_RETURN_TO_STORAGE_KEY = "oauth_login_return_to";

export function sanitizeLoginReturnTo(value: string | null | undefined): string | null {
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function resolveLoginReturnTo(
  searchParams: { get(name: string): string | null },
  pendingOAuthReturnTo?: string | null,
): string {
  return (
    sanitizeLoginReturnTo(searchParams.get("returnTo")) ??
    sanitizeLoginReturnTo(pendingOAuthReturnTo) ??
    DEFAULT_LOGIN_RETURN_TO
  );
}
