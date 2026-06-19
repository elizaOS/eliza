import { chromium, type FullConfig } from "@playwright/test";

/**
 * Warm up Vite's dev-mode dependency optimizer before any timed test runs.
 *
 * When the audit's webServer is the Vite dev server (not preview), the first
 * request that pulls a transformed module triggers
 * `[vite] [optimizer] scanning dependencies... bundling dependencies...`. On a
 * cold start that scan delays the entry module past Playwright's 60s default,
 * so whichever route runs first (alphabetically `landing`/`/` for
 * `tests/e2e/aesthetic-audit.spec.ts`) times out — even though the server
 * returns the HTML shell in milliseconds.
 *
 * A plain `fetch(baseUrl)` is NOT enough: it returns `index.html` without
 * pulling any `<script type="module">`, so Vite never runs the optimizer and
 * the cold scan still lands on the first real test navigation. Worse, the
 * Playwright `webServer.url` readiness probe already GETs `/`, so a bare fetch
 * here is essentially a no-op.
 *
 * Instead we drive a real (headless) navigation: loading the document pulls
 * the entry module and its import graph, which is exactly what forces Vite to
 * complete the dependency optimize pass. Once it's warm, every subsequent test
 * `goto()` races nothing.
 *
 * Skips entirely when CLOUD_E2E_LIVE_URL is set (real deployed site — no local
 * dev server, no optimizer).
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.CLOUD_E2E_LIVE_URL) {
    return;
  }

  const host = process.env.PLAYWRIGHT_HOST || "127.0.0.1";
  const port = process.env.PLAYWRIGHT_PORT || "4173";
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://${host}:${port}`;

  // The cold optimize pass can take ~15–20s; allow comfortable headroom for
  // slower shared CI runners without being wasteful in the warm case (the
  // navigation resolves in <1s once Vite has already optimized).
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // `load` (not `networkidle`) is enough — we only need Vite to have served
    // the entry module graph, which completes the optimizer crawl.
    await page.goto(baseUrl, { waitUntil: "load", timeout: 90_000 });
  } catch (err) {
    // Don't fail the whole run on a warmup hiccup — the real tests will
    // surface genuine problems with clearer, per-route errors than this would.
    // Log so a flake is at least traceable.
    console.warn(
      `[global-setup] Vite optimizer warmup failed (${baseUrl}):`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    await browser.close();
  }
}
