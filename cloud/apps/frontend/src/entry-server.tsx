/**
 * SSR entry — renders the landing route to a static HTML string at build time.
 *
 * The output is spliced into `dist/index.html` by `scripts/prerender.mjs` so
 * the browser paints real content during the FCP/LCP window instead of the
 * empty `<div id="root"></div>` shell. Once the main bundle hydrates, the
 * SPA takes over.
 *
 * To minimize hydration mismatches, the SSR tree mirrors what `RootLayout`
 * renders into `<div id="root">` for an anonymous landing visitor:
 *
 *   <Helmet> head metadata
 *   <Outlet> — the landing page content
 *   <Toaster> — sonner toaster (renders an empty list when no toasts)
 *
 * The Steward / Credits providers in RootLayout are deliberately
 * NOT wrapped here. They (a) only read state via `useEffect` (no DOM impact)
 * or (b) depend on client-only browser APIs during initialization. Skipping
 * them on the server is safe because
 * `useSessionAuth` returns the unauthenticated fallback when the Steward
 * context is null — exactly what an anonymous landing visitor sees on the
 * client during the first paint.
 */

import { Buffer } from "buffer";

if (typeof globalThis !== "undefined" && !("Buffer" in globalThis)) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

import { renderToString } from "react-dom/server";
import { HelmetProvider, type HelmetServerState } from "react-helmet-async";
import { StaticRouter } from "react-router";
import { Toaster } from "sonner";
import LandingPageRoute from "./pages/page";
import "./globals.css";

export interface RenderResult {
  html: string;
  helmet?: HelmetServerState;
}

interface HelmetContext {
  helmet?: HelmetServerState;
}

/** Mirror of the Toaster props used in `RootLayout.tsx` so SSR output matches. */
const TOASTER_PROPS = {
  richColors: true,
  theme: "dark" as const,
  position: "top-right" as const,
  toastOptions: {
    style: {
      background: "rgba(0, 0, 0, 0.8)",
      border: "1px solid rgba(255, 255, 255, 0.1)",
      color: "white",
      backdropFilter: "blur(12px)",
      borderRadius: "0px",
    },
    className: "font-sf-pro",
  },
};

export function render(url: string): RenderResult {
  const helmetContext: HelmetContext = {};

  const html = renderToString(
    <HelmetProvider context={helmetContext}>
      <StaticRouter location={url}>
        <LandingPageRoute />
        <Toaster {...TOASTER_PROPS} />
      </StaticRouter>
    </HelmetProvider>,
  );

  return { html, helmet: helmetContext.helmet };
}
