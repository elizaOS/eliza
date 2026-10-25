/**
 * Entry point of the Design Lab: mounts DesignLab under the same context
 * providers the app shell supplies (mock app store, translation, tooltips) so
 * every real surface resolves its hooks without the app running.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@ui-src/styles.ts";
import { TooltipProvider } from "@ui-src/components/ui/tooltip.tsx";
import { TranslationProvider } from "@ui-src/state/TranslationProvider.tsx";
import { MockAppProvider } from "@ui-src/storybook/mock-providers.tsx";

import { DesignLab } from "./DesignLab.tsx";
import "./lab.css";

try {
  if (!localStorage.getItem("eliza:ui-language")) {
    localStorage.setItem("eliza:ui-language", "en");
  }
} catch {
  // error-policy:J4 design-lab-only degrade — storage-blocked browsers still
  // render the lab, with the missing persisted language exposed for diagnostics.
  document.documentElement.dataset.designLabStorage = "unavailable";
}

const container = document.getElementById("root");
if (!container) throw new Error("root element missing");

createRoot(container).render(
  <StrictMode>
    <TranslationProvider>
      <MockAppProvider>
        <TooltipProvider delayDuration={200} skipDelayDuration={100}>
          <DesignLab />
        </TooltipProvider>
      </MockAppProvider>
    </TranslationProvider>
  </StrictMode>,
);
