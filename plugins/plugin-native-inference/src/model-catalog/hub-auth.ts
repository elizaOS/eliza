/**
 * Model-hub authentication helpers.
 *
 * Gated/metered HuggingFace repos require an `Authorization: Bearer <token>`
 * header or they answer `HTTP 401`/`403` (and gated repos are invisible to
 * unauthenticated search, reporting wrong/zero sizes). The token is read from
 * the same env aliases the embedding manager uses
 * (`HF_TOKEN` / `HUGGINGFACE_TOKEN` / `HF_HUB_TOKEN`).
 *
 * The token is **host-gated**: it is only attached to `huggingface.co`
 * requests, never leaked to ModelScope or arbitrary mirrors. Every model
 * download and search path forwards it through {@link resolveHubAuthHeaders}.
 */

/** Read the HuggingFace token from the documented env aliases. `""` when unset. */
export function resolveHuggingFaceToken(): string {
  if (typeof process === "undefined" || !process.env) return "";
  return (
    process.env.HF_TOKEN?.trim() ||
    process.env.HUGGINGFACE_TOKEN?.trim() ||
    process.env.HF_HUB_TOKEN?.trim() ||
    ""
  );
}

/** True when a configured HuggingFace token is present in the environment. */
export function hasHuggingFaceToken(): boolean {
  return resolveHuggingFaceToken().length > 0;
}

/** True when `url` points at huggingface.co (or a subdomain of it). */
export function isHuggingFaceHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "huggingface.co" || host.endsWith(".huggingface.co");
  } catch {
    return false;
  }
}

/**
 * Auth headers for a model-hub request. Returns the bearer header only for
 * huggingface.co URLs when a token is configured; `{}` otherwise (public repos
 * and non-HF hosts are unaffected, and tokens never leak to other hosts).
 */
export function resolveHubAuthHeaders(url: string): Record<string, string> {
  if (!isHuggingFaceHost(url)) return {};
  const token = resolveHuggingFaceToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
