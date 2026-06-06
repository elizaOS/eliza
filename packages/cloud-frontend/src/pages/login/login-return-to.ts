const DEFAULT_LOGIN_RETURN_TO = "/dashboard/agents";
const PENDING_OAUTH_RETURN_TO_KEY = "eliza.cloud.login.pendingReturnTo";

export function sanitizeLoginReturnTo(
  value: string | null | undefined,
): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
}

export function storePendingOAuthReturnTo(returnTo: string): boolean {
  const sanitized = sanitizeLoginReturnTo(returnTo);
  if (!sanitized || typeof window === "undefined") return false;

  try {
    window.sessionStorage.setItem(PENDING_OAUTH_RETURN_TO_KEY, sanitized);
    return true;
  } catch {
    return false;
  }
}

export function consumePendingOAuthReturnTo(): string | null {
  if (typeof window === "undefined") return null;

  try {
    const returnTo = window.sessionStorage.getItem(PENDING_OAUTH_RETURN_TO_KEY);
    window.sessionStorage.removeItem(PENDING_OAUTH_RETURN_TO_KEY);
    return sanitizeLoginReturnTo(returnTo);
  } catch {
    return null;
  }
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
