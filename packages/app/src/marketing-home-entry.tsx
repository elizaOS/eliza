/**
 * Mounts the marketing homepage without the Cloud auth/router or service-worker
 * graphs, keeping the first useful render independent of wallet and app code.
 */

import "@elizaos/ui/styles";
import "./renderer-build-stamp";

import { ErrorBoundary } from "@elizaos/ui/components/ui/error-boundary";
import EmbeddedHomePage from "@homepage/embedded-home";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderBootFailure } from "./boot-failure";

function mountMarketingHome(): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Root element #root not found");
  createRoot(rootElement).render(
    <ErrorBoundary>
      <React.StrictMode>
        <EmbeddedHomePage />
      </React.StrictMode>
    </ErrorBoundary>,
  );
}

function bootMarketingHome(): void {
  try {
    mountMarketingHome();
  } catch (error) {
    // error-policy:J1 marketing renderer boundary — preserve the established
    // actionable recovery when the initial mount fails.
    renderBootFailure(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootMarketingHome, {
    once: true,
  });
} else {
  bootMarketingHome();
}
