const DEFAULT_LOGIN_RETURN_TO = "/dashboard/agents";

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
