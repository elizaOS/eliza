// Buffer polyfill - must run before any other import so libraries that read
// `globalThis.Buffer` at module-init time (Solana wallet adapters, viem,
// ethers, etc.) see the real implementation. The `buffer` package is the
// canonical browser polyfill and exports the same API as Node's Buffer.
import { Buffer } from "buffer";

if (typeof globalThis !== "undefined" && !("Buffer" in globalThis)) {
  (globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
}

import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./globals.css";
import { queryClient } from "./lib/query-client";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found in index.html");

const tree = (
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HelmetProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </HelmetProvider>
    </QueryClientProvider>
  </React.StrictMode>
);

// When the build-time prerender (`scripts/prerender.mjs`) injected real HTML
// into `<div id="root">`, hydrate that markup so React adopts it without
// blowing it away (this is what makes the FCP/LCP win stick instead of
// flashing the SSR'd content). Otherwise, routes we don't pre-render (auth,
// dashboard, etc.) fall back to a fresh client render.
//
// React hydration is forgiving of small mismatches (it warns and patches the
// DOM) but it cannot recover from a totally different tree, so we only
// hydrate when the root has children that look like our prerender output.
const normalizedPath = window.location.pathname.replace(/\/$/, "") || "/";
const prerenderPath = rootEl.dataset.prerenderPath;
const hasMatchingPrerenderedMarkup =
  rootEl.firstElementChild !== null &&
  rootEl.dataset.prerenderMismatch !== "true" &&
  (prerenderPath ?? "/") === normalizedPath;

performance.mark("eliza:cloud-hydration-start");
if (hasMatchingPrerenderedMarkup) {
  hydrateRoot(rootEl, tree);
} else {
  performance.mark("eliza:cloud-prerender-mismatch");
  if (rootEl.firstElementChild !== null) {
    rootEl.textContent = "";
  }
  createRoot(rootEl).render(tree);
}
requestAnimationFrame(() => {
  performance.mark("eliza:cloud-hydration-end");
  performance.measure(
    "eliza:cloud-hydration",
    "eliza:cloud-hydration-start",
    "eliza:cloud-hydration-end",
  );
});
