import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ui-src/styles.ts";
import { TooltipProvider } from "@ui-src/components/ui/tooltip.tsx";
import { TranslationProvider } from "@ui-src/state/TranslationContext.tsx";
import { App } from "./App.tsx";
import "./stories.css";

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
