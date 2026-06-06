const DEFAULT_LOGIN_RETURN_TO = "/dashboard/agents";
const PENDING_OAUTH_RETURN_TO_KEY = "eliza.login.oauth.returnTo";
const PENDING_OAUTH_RETURN_TO_TTL_MS = 10 * 60 * 1000;

type StoredReturnTo = {
  returnTo: string;
  expiresAt: number;
};

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
  if (!returnTo) return;
  const stored = JSON.stringify({
    returnTo,
    expiresAt: Date.now() + PENDING_OAUTH_RETURN_TO_TTL_MS,
  } satisfies StoredReturnTo);
  safeSet(window.sessionStorage, stored);
  safeSet(window.localStorage, stored);
}

export function consumePendingOAuthReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  const sessionReturnTo = safeConsume(window.sessionStorage);
  const localReturnTo = safeConsume(window.localStorage);
  return sessionReturnTo ?? localReturnTo;
}

function safeSet(storage: Storage, value: string): void {
  try {
    storage.setItem(PENDING_OAUTH_RETURN_TO_KEY, value);
  } catch {
    // Storage can be disabled in private browsing modes. Losing returnTo is
    // better than putting it back into OAuth redirect_uri and failing login.
  }
}

function safeConsume(storage: Storage): string | null {
  try {
    const value = storage.getItem(PENDING_OAUTH_RETURN_TO_KEY);
    storage.removeItem(PENDING_OAUTH_RETURN_TO_KEY);
    return parseStoredReturnTo(value);
  } catch {
    return null;
  }
}

function parseStoredReturnTo(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredReturnTo>;
    if (
      typeof parsed.returnTo === "string" &&
      typeof parsed.expiresAt === "number" &&
      parsed.expiresAt >= Date.now()
    ) {
      return sanitizeLoginReturnTo(parsed.returnTo);
    }
    return null;
  } catch {
    return sanitizeLoginReturnTo(value);
  }
}
