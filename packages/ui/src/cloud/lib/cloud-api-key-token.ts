/**
 * Discriminates an Eliza Cloud API key from other bearer tokens.
 *
 * Cloud API keys are `eliza_`-prefixed. The on-device agent bearer that
 * `first-run-finish` mirrors into `bootConfig.apiToken` on a local-agent
 * install is NOT — so it must never be mistaken for a cloud session, or a user
 * who never cloud-signed-in is reported `authenticated` and the Apps tab sends
 * the local bearer to api.elizacloud.ai (401 → error state instead of a
 * sign-in prompt). See #12046.
 */
export function isCloudApiKeyToken(token: string | null | undefined): boolean {
  return typeof token === "string" && token.trim().startsWith("eliza_");
}
