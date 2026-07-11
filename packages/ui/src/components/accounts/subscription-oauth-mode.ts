export type SubscriptionOAuthMode = "localhost" | "device";

export function subscriptionOAuthModeForHostname(
  hostname: string,
): SubscriptionOAuthMode {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
    ? "localhost"
    : "device";
}
