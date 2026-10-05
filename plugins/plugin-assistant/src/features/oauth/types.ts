/**
 * OAuth provider names shared with cloud provider alignment and connector setup.
 * Connector-owned providers remain distinguishable from cloud registry entries.
 */

export type OAuthProvider =
  | "google"
  | "discord"
  | "github"
  | "notion"
  | "slack"
  | "linkedin"
  | "linear"
  | "shopify"
  | "calendly";

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  "google",
  "discord",
  "github",
  "notion",
  "slack",
  "linkedin",
  "linear",
  "shopify",
  "calendly",
] as const;

/**
 * Providers whose OAuth is serviced by a connector (not the cloud provider
 * registry); exempt from the core ⊆ cloud-registry alignment check.
 */
export const CONNECTOR_NATIVE_OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  "discord",
] as const;
