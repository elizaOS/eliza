const DEFAULT_LOGIN_RETURN_TO = "/dashboard/agents";
const PENDING_OAUTH_RETURN_TO_KEY = "eliza.login.oauth.returnTo";

function sanitizeLoginReturnTo(
  value: string | null | undefined,
): string | null {
  return value?.startsWith("/") && !value.startsWith("//") ? value : null;
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

export function storePendingOAuthReturnTo(searchParams: {
  get(name: string): string | null;
}): void {
  if (typeof window === "undefined") return;
  const returnTo = sanitizeLoginReturnTo(searchParams.get("returnTo"));
  try {
    if (returnTo) {
      window.sessionStorage.setItem(PENDING_OAUTH_RETURN_TO_KEY, returnTo);
    }
  } catch {
    // Storage can be disabled in private browsing modes. Losing returnTo is
    // better than putting it back into OAuth redirect_uri and failing login.
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
