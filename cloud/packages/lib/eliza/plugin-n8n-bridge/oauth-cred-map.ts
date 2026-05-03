/**
 * Maps n8n credential type names to cloud OAuth platform IDs.
 *
 * n8n uses specific credential type names (e.g. "gmailOAuth2Api", "googleSheetsOAuth2Api")
 * while the cloud registry uses platform IDs (e.g. "google", "slack").
 *
 * Each platform declares the credential name prefixes it owns.
 * A prefix match means the n8n credential type belongs to that cloud platform.
 *
 * Current coverage: 32 n8n credential types across 6 cloud platforms.
 * Adding a new cloud platform = add one entry here + register in provider-registry.
 */

/**
 * Cloud platform → n8n credential name prefixes.
 *
 * n8n follows strict naming: all Google creds start with "google", "gmail", "gSuite", or "youTube".
 * This is stable — n8n has maintained this convention across 300+ credential types.
 */
const PLATFORM_PREFIXES: Record<string, string[]> = {
  google: ["gmail", "google", "gSuite", "youTube"],
  slack: ["slack"],
  github: ["github"],
  linear: ["linear"],
  notion: ["notion"],
  twitter: ["twitter"],
};

// Pre-computed reverse: sorted longest-prefix-first for correct matching
const PREFIX_TO_PLATFORM: [string, string][] = Object.entries(PLATFORM_PREFIXES)
  .flatMap(([platform, prefixes]) => prefixes.map((p): [string, string] => [p, platform]))
  .sort((a, b) => b[0].length - a[0].length);

/**
 * Map an n8n credential type to a cloud platform ID.
 *
 * @returns Platform ID (e.g. "google") or null if unsupported.
 *
 * @example
 * mapCredTypeToCloudPlatform("gmailOAuth2")            // "google"
 * mapCredTypeToCloudPlatform("googleSheetsOAuth2Api")   // "google"
 * mapCredTypeToCloudPlatform("slackOAuth2Api")          // "slack"
 * mapCredTypeToCloudPlatform("hubspotOAuth2Api")        // null
 */
export function mapCredTypeToCloudPlatform(credType: string): string | null {
  for (const [prefix, platform] of PREFIX_TO_PLATFORM) {
    if (credType.startsWith(prefix)) return platform;
  }
  return null;
}

/**
 * Get all n8n credential name prefixes for a cloud platform.
 *
 * Used by spec 09 (integration availability check) to determine
 * which n8n nodes are supported by the platform.
 */
export function getCredPrefixesForPlatform(platform: string): string[] {
  return PLATFORM_PREFIXES[platform] ?? [];
}
