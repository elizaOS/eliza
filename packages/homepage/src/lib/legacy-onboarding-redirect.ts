/**
 * Redirects continuation links previously issued on eliza.app into the
 * authenticated Cloud app while leaving organic homepage onboarding intact.
 */

const LEGACY_HOMEPAGE_HOSTS = new Set(["eliza.app", "www.eliza.app"]);
const CLOUD_APP_ORIGIN = "https://app.elizacloud.ai";

export function getLegacyOnboardingRedirect(location: {
  hostname: string;
  pathname: string;
  search: string;
  hash: string;
}): string | null {
  if (
    !LEGACY_HOMEPAGE_HOSTS.has(location.hostname.toLowerCase()) ||
    location.pathname !== "/get-started" ||
    !new URLSearchParams(location.search).has("onboardingSession")
  ) {
    return null;
  }

  return `${CLOUD_APP_ORIGIN}${location.pathname}${location.search}${location.hash}`;
}
