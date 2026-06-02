import type { FullConfig } from "@playwright/test";

/**
 * Warm up Vite's dev-mode dependency optimizer before any timed test runs.
 *
 * When the audit's webServer is the Vite dev server (not preview), the very
 * first navigation triggers `[vite] [optimizer] scanning dependencies...
 * bundling dependencies...`. On a cold start this delays `DOMContentLoaded`
 * past Playwright's 60s default, so whichever route runs first
 * (alphabetically `landing`/`/` for `tests/e2e/aesthetic-audit.spec.ts`) and
 * any other route that touches a not-yet-optimized chunk both time out —
 * even though the server returns 200 in milliseconds when probed directly.
 *
 * Issuing a single GET against the base URL here, with a longer timeout
 * than the per-test one, lets the optimizer complete before the real run
 * starts. Subsequent navigations hit the warm cache and finish in <1s.
 *
 * Skips entirely when CLOUD_E2E_LIVE_URL is set (real deployed site — no
 * local dev server, no optimizer).
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.CLOUD_E2E_LIVE_URL) {
    return;
  }

  const host = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
  const port = process.env.PLAYWRIGHT_PORT || "4173";
  const baseUrl =
    process.env.PLAYWRIGHT_BASE_URL || `http://${host}:${port}`;

  // The optimizer can take ~15–20s on a cold first navigation. Allow up to
  // 90s so headless Chromium on slower machines still warms up reliably.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(baseUrl, { signal: controller.signal });
    // We don't care about the body; just consuming the stream is what
    // forces Vite to finish optimizing imports referenced by the root
    // module graph. Subsequent test goto()s then race nothing.
    await response.text();
  } catch (err) {
    // Don't fail the whole run if warmup hits a transient issue — the
    // tests will surface real problems with clearer errors than this
    // would. Log so a flake is at least traceable.
    // biome-ignore lint/suspicious/noConsole: setup diagnostics
    console.warn(
      `[global-setup] Vite optimizer warmup failed (${baseUrl}):`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}
