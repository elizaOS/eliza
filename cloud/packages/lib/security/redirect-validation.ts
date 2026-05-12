import { isAllowedOrigin } from "@/lib/security/origin-validation";

const DEFAULT_PLATFORM_REDIRECT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "https://eliza.ai",
  "https://www.eliza.ai",
  "https://eliza.app",
];

/**
 * Wildcard loopback origins, safe to include alongside any production allowlist.
 *
 * Agent's desktop dev server binds to localhost on a pre-picked free port
 * (defaults 2138/31337 — see docs/apps/desktop-local-development.md), so the
 * exact port is not known up front. Matching any loopback port during local
 * dev lets OAuth flows initiated from the desktop bounce back to the
 * originating Agent instance.
 */
export const LOOPBACK_REDIRECT_ORIGINS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "https://localhost:*",
  "https://127.0.0.1:*",
] as const;

function isHttpUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function hasEmbeddedCredentials(url: URL): boolean {
  return url.username.length > 0 || url.password.length > 0;
}

export function getDefaultPlatformRedirectOrigins(): string[] {
  return [process.env.NEXT_PUBLIC_APP_URL?.trim(), ...DEFAULT_PLATFORM_REDIRECT_ORIGINS].filter(
    (value): value is string => !!value,
  );
}

export function isSafeRelativeRedirectPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

export function sanitizeRelativeRedirectPath(
  value: string | null | undefined,
  fallbackPath: string,
): string {
  if (!value) {
    return fallbackPath;
  }

  return isSafeRelativeRedirectPath(value) ? value : fallbackPath;
}

export function isAllowedAbsoluteRedirectUrl(value: string, allowedOrigins: string[]): boolean {
  try {
    const parsed = new URL(value);
    if (!isHttpUrl(parsed) || hasEmbeddedCredentials(parsed)) {
      return false;
    }

    return isAllowedOrigin(allowedOrigins, parsed.toString());
  } catch {
    return false;
  }
}

export function assertAllowedAbsoluteRedirectUrl(
  value: string,
  allowedOrigins: string[],
  label = "redirect URL",
): URL {
  if (!isAllowedAbsoluteRedirectUrl(value, allowedOrigins)) {
    throw new Error(`Invalid ${label}`);
  }

  return new URL(value);
}

export function resolveSafeRedirectTarget(
  value: string | null | undefined,
  baseUrl: string,
  fallbackPath: string,
): URL {
  const safeFallback = new URL(fallbackPath, baseUrl);

  if (!value) {
    return safeFallback;
  }

  if (isSafeRelativeRedirectPath(value)) {
    return new URL(value, baseUrl);
  }

  try {
    const parsed = new URL(value);
    const base = new URL(baseUrl);

    if (isHttpUrl(parsed) && !hasEmbeddedCredentials(parsed) && parsed.origin === base.origin) {
      return parsed;
    }
  } catch {
    // Fall back to the default route below.
  }

  return safeFallback;
}

export interface ResolveOAuthSuccessRedirectParams {
  value: string | null | undefined;
  baseUrl: string;
  fallbackPath: string;
  allowedAbsoluteOrigins: readonly string[];
}

export interface ResolveOAuthSuccessRedirectResult {
  target: URL;
  rejected: boolean;
}

/**
 * Resolve an OAuth-callback redirect target, accepting:
 *   - relative paths on `baseUrl`
 *   - absolute URLs on `baseUrl`
 *   - absolute URLs whose origin is in `allowedAbsoluteOrigins` (Agent app
 *     origins, loopback dev origins, configured extras)
 *
 * Anything else falls back to `baseUrl + fallbackPath` and `rejected` is true
 * so callers can log the refusal.
 */
export function resolveOAuthSuccessRedirectUrl(
  params: ResolveOAuthSuccessRedirectParams,
): ResolveOAuthSuccessRedirectResult {
  const { value, baseUrl, fallbackPath, allowedAbsoluteOrigins } = params;
  const safeFallback = new URL(fallbackPath, baseUrl);

  if (!value) {
    return { target: safeFallback, rejected: false };
  }

  if (isSafeRelativeRedirectPath(value)) {
    return { target: new URL(value, baseUrl), rejected: false };
  }

  try {
    const parsed = new URL(value);
    if (!isHttpUrl(parsed) || hasEmbeddedCredentials(parsed)) {
      return { target: safeFallback, rejected: true };
    }

    const base = new URL(baseUrl);
    if (parsed.origin === base.origin) {
      return { target: parsed, rejected: false };
    }

    if (isAllowedOrigin([...allowedAbsoluteOrigins], parsed.toString())) {
      return { target: parsed, rejected: false };
    }
  } catch {
    // Fall through to the rejection branch below.
  }

  return { target: safeFallback, rejected: true };
}
