/**
 * Selects the lightweight hosted public and account-management renderer without changing the
 * native, desktop, chat-harness, or agent-application boot paths.
 *
 * Keep these exact pathname patterns aligned with the routes registered by
 * `@elizaos/ui/cloud/register-public`. Near misses deliberately fall through
 * to the full application outside the managed Cloud namespace so an unknown URL cannot reload-loop at the public
 * shell catch-all.
 */

export interface WebEntryDecisionInput {
  pathname: string;
  hostname: string;
  webShellEnabled: boolean;
  chatHarnessEnabled: boolean;
  desktopShell: boolean;
  forceApexConsole: boolean;
}

const EXACT_PUBLIC_PATHS = new Set([
  "/accept-invitation",
  "/account-deletion",
  "/app-auth/authorize",
  "/auth/bridge",
  "/auth/callback/email",
  "/auth/cli-login",
  "/auth/error",
  "/auth/success",
  "/bsc",
  "/get-started",
  "/invite/accept",
  "/join",
  "/login",
  "/oidc/continue",
  "/pricing",
  "/privacy-policy",
  "/terms-of-service",
]);

const PARAMETRIC_PUBLIC_PATHS = [
  /^\/approve\/[^/]+$/,
  /^\/ballot\/[^/]+$/,
  /^\/chat\/[^/]+$/,
  /^\/payment\/[^/]+$/,
  /^\/payment\/app-charge\/[^/]+\/[^/]+$/,
  /^\/sensitive-requests\/[^/]+$/,
] as const;

function normalizePathname(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

/** Whether the path is owned completely by the hosted public route table. */
export function isHostedPublicPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    EXACT_PUBLIC_PATHS.has(normalized) ||
    PARAMETRIC_PUBLIC_PATHS.some((pattern) => pattern.test(normalized))
  );
}

/** Decide which renderer entry may execute before any application modules load. */
export function shouldUsePublicWebEntry(input: WebEntryDecisionInput): boolean {
  if (
    !input.webShellEnabled ||
    input.chatHarnessEnabled ||
    input.desktopShell
  ) {
    return false;
  }
  if (isHostedPublicPath(input.pathname)) return true;
  const pathname = normalizePathname(input.pathname);
  if (
    pathname === "/cloud" ||
    pathname.startsWith("/cloud/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/")
  )
    return true;
  if (normalizePathname(input.pathname) !== "/") return false;
  return input.forceApexConsole;
}
