/**
 * Proxy configuration — named aliases and defaults.
 *
 * Aliases let agents use short names instead of full hostnames:
 *   /openai/v1/chat/completions → api.openai.com/v1/chat/completions
 *
 * Per-tenant aliases will be configurable via DB in a future release.
 */

export const DEFAULT_ALIASES: Record<string, string> = {
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  birdeye: "public-api.birdeye.so",
  coingecko: "api.coingecko.com",
  helius: "api.helius.xyz",
};

/** Default port for the proxy server */
export const PROXY_PORT = parseInt(process.env.STEWARD_PROXY_PORT || "8080", 10);

/** Required JWT scope for proxy access */
export const PROXY_SCOPE = "api:proxy";
