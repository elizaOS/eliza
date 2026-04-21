const GOOGLE_REAUTH_PATTERNS = [
  "invalid_grant",
  "expired or revoked",
  "token has been expired or revoked",
  "needs re-authentication",
  "needs reauthentication",
  "insufficient authentication scopes",
] as const;

const GOOGLE_ADMIN_POLICY_PATTERNS = [
  "admin policy",
  "administrator",
  "not allowed by your organization",
  "not allowed by your domain",
  "access blocked",
  "workspace",
  "restricted to users within its organization",
] as const;

function messageContainsAny(
  message: string,
  patterns: readonly string[],
): boolean {
  const normalized = message.trim().toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

export function googleErrorRequiresReauth(
  status: number,
  message: string,
): boolean {
  return status === 401 || messageContainsAny(message, GOOGLE_REAUTH_PATTERNS);
}

export function googleErrorLooksLikeAdminPolicyBlock(message: string): boolean {
  return messageContainsAny(message, GOOGLE_ADMIN_POLICY_PATTERNS);
}
