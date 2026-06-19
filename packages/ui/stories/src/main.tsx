import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import { TooltipProvider } from "@ui-src/components/ui/tooltip.tsx";
import { TranslationProvider } from "@ui-src/state/TranslationProvider.tsx";
import { App } from "./App.tsx";
import "./stories.css";

// The catalog has no API backend, so seed a stored UI language. That makes
// TranslationProvider treat this as a returning visitor and skip the
// first-visit `/api/i18n/locale` geo-suggestion fetch (which would 404 here).
try {
  if (!localStorage.getItem("eliza:ui-language")) {
    localStorage.setItem("eliza:ui-language", "en");
  }
} catch {
  // localStorage unavailable (private mode) — the fetch just stays best-effort.
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("root element missing");
}
// Catalog components call `useTranslation` (and Radix tooltips), so the gallery
// must provide the same context wrappers the app shell does.
createRoot(container).render(
  <StrictMode>
    <TranslationProvider>
      <TooltipProvider delayDuration={200} skipDelayDuration={100}>
        <App />
      </TooltipProvider>
    </TranslationProvider>
  </StrictMode>,
);
