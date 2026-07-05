/**
 * Alias-aware resolution of the two brand-aliased env vars the Electrobun main
 * process reads at boot: the renderer URL and the app namespace. Both keys carry
 * `<BRAND>_*` partners in the shared alias table, so they are read through
 * `readAliasedEnv`, which resolves a branded alias off the immutable BootConfig
 * WITHOUT mutating `process.env` (canonical `ELIZA_*` wins; blank is unset). The
 * reads live here rather than inline in `index.ts` — the Electrobun entry has
 * heavy top-level side effects and is not unit-testable — so the resolution
 * contract can be exercised directly by `brand-env-reads.test.ts`.
 */
import { readAliasedEnv } from "@elizaos/shared";

/**
 * Renderer URL for the desktop webview: an explicit `ELIZA_RENDERER_URL` (or its
 * brand alias) wins, then Vite's `VITE_DEV_SERVER_URL`, else empty so the caller
 * falls back to the bundled static server. `VITE_DEV_SERVER_URL` is a Vite
 * convention with no brand alias and stays a direct read.
 */
export function resolveRendererUrlFromEnv(): string {
  return (
    readAliasedEnv("ELIZA_RENDERER_URL") ??
    process.env.VITE_DEV_SERVER_URL ??
    ""
  );
}

/**
 * App namespace used to locate the per-brand state-dir `.env`. Falls back to the
 * compiled-in brand namespace when `ELIZA_NAMESPACE` (or its brand alias) is unset.
 */
export function resolveNamespaceFromEnv(fallback: string): string {
  return readAliasedEnv("ELIZA_NAMESPACE") ?? fallback;
}
