/**
 * Mounts only the Cloud public/auth/marketing route shell for a cold hosted
 * public URL. The full application graph stays out of anonymous `/login`, then
 * loads into the same document when client-side navigation leaves that route
 * table so successful authentication does not reboot the browser page.
 */

import "@elizaos/ui/styles";
import "./renderer-build-stamp";

import { ErrorBoundary } from "@elizaos/ui";
import { registerPublicCloudSurfaces } from "@elizaos/ui/cloud/register-public";
import { CloudRouterShell } from "@elizaos/ui/cloud/shell/CloudRouterShell";
import * as React from "react";
import { lazy, Suspense, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderBootFailure } from "./boot-failure";
import { seedPublicWebBootConfig } from "./public-web-boot-config";
import { registerViewServiceWorker } from "./sw-registration";

const MarketingHomePage = lazy(() => import("@homepage/embedded-home"));
const MarketingDownloadsPage = lazy(
  () => import("@homepage/embedded-downloads"),
);

let publicRoot: Root | null = null;
let fullAppHandoffStarted = false;

async function handoffToFullApp(): Promise<void> {
  if (fullAppHandoffStarted) return;
  fullAppHandoffStarted = true;

  // React must finish the current effect before its root is removed. The full
  // renderer's side-effect entry then mounts into the now-empty #root without
  // replacing the document, history, or service-worker-controlled client.
  await Promise.resolve();
  publicRoot?.unmount();
  publicRoot = null;
  await import("./main");
}

/**
 * A public-route link can navigate into the application without reloading the
 * document. Swap renderer roots at that catch-all while preserving the same
 * browser document and navigation history.
 */
function FullAppHandoff(): React.JSX.Element {
  useEffect(() => {
    // error-policy:J1 renderer handoff boundary — a failed full-app import
    // renders the established actionable recovery card.
    void handoffToFullApp().catch(renderBootFailure);
  }, []);
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="flex min-h-dvh items-center justify-center bg-black text-sm text-white/60"
    >
      Loading Eliza…
    </main>
  );
}

function mountPublicWebEntry(): void {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Root element #root not found");
  // Seed env-derived Cloud API base before join/auth routes read boot config.
  seedPublicWebBootConfig();
  registerViewServiceWorker();
  registerPublicCloudSurfaces();
  publicRoot = createRoot(rootElement);
  publicRoot.render(
    <ErrorBoundary>
      <React.StrictMode>
        <Suspense fallback={null}>
          <CloudRouterShell
            marketingHomeElement={<MarketingHomePage />}
            downloadsElement={<MarketingDownloadsPage />}
            appElement={<FullAppHandoff />}
          />
        </Suspense>
      </React.StrictMode>
    </ErrorBoundary>,
  );
}

function bootPublicWebEntry(): void {
  try {
    mountPublicWebEntry();
  } catch (error) {
    // error-policy:J1 public renderer boundary — preserve the established
    // reload recovery when registration or the initial mount fails.
    renderBootFailure(error);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootPublicWebEntry, {
    once: true,
  });
} else {
  bootPublicWebEntry();
}
