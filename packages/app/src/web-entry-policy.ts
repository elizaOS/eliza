/**
 * Selects the lightweight hosted-public renderer entry without changing the
 * native, desktop, chat-harness, or agent-application boot paths.
 *
 * Keep these exact pathname patterns aligned with the routes registered by
 * `@elizaos/ui/cloud/register-public`. Near misses deliberately fall through
 * to the full application so an unknown URL cannot reload-loop at the public
 * shell catch-all.
 */

import { classifyElizaHostname } from "@elizaos/shared/elizacloud/domain-contract";

export interface WebEntryDecisionInput {
  pathname: string;
  hostname: string;
  webShellEnabled: boolean;
  chatHarnessEnabled: boolean;
  desktopShell: boolean;
  forceApexConsole: boolean;
  forceMarketingHome: boolean;
}

const EXACT_PUBLIC_PATHS = new Set([
  "/accept-invitation",
  "/app-auth/authorize",
  "/auth/bridge",
  "/auth/callback/email",
  "/auth/cli-login",
  "/auth/error",
  "/auth/success",
  "/bsc",
  "/downloads",
  "/get-started",
  "/invite/accept",
  "/join",
  "/login",
  "/oidc/continue",
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

/** Whether the URL can use the marketing-only root without the auth router. */
export function shouldUseMarketingHomeEntry(
  input: WebEntryDecisionInput,
): boolean {
  const isRootPath = normalizePathname(input.pathname) === "/";
  if (
    input.forceMarketingHome &&
    !input.chatHarnessEnabled &&
    !input.desktopShell &&
    isRootPath
  ) {
    return true;
  }
  if (
    !input.webShellEnabled ||
    input.chatHarnessEnabled ||
    input.desktopShell ||
    !isRootPath
  ) {
    return false;
  }
  const role = classifyElizaHostname(input.hostname).role;
  return role === "marketing" || role === "legacy-marketing";
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
  if (normalizePathname(input.pathname) !== "/") return false;
  if (input.forceApexConsole) return true;
  return shouldUseMarketingHomeEntry(input);
}
