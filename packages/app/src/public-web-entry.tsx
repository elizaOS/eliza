/**
 * Mounts only the Cloud public/auth/marketing route shell for a cold hosted
 * public URL. The full application entry remains behind a document reload when
 * client-side navigation leaves that route table, so none of its native,
 * bridge, plugin, or agent-dashboard imports enter anonymous `/login`.
 */

import "@elizaos/ui/styles";
import "./renderer-build-stamp";

import { registerPublicCloudSurfaces } from "@elizaos/ui/cloud/register-public";
import { CloudRouterShell } from "@elizaos/ui/cloud/shell/CloudRouterShell";
import { ErrorBoundary } from "@elizaos/ui/components/ui/error-boundary";
import * as React from "react";
import { lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderBootFailure } from "./boot-failure";
import { registerViewServiceWorker } from "./sw-registration";

const MarketingHomePage = lazy(() => import("@homepage/embedded-home"));
const MarketingDownloadsPage = lazy(
  () => import("@homepage/embedded-downloads"),
);

/**
 * A public-route link can navigate into the application without reloading the
 * document. Reload once at that catch-all so `entry.ts` selects the full boot
 * for the new, non-public pathname.
 */
function FullAppHandoff(): React.JSX.Element {
  useEffect(() => {
    window.location.reload();
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
  registerViewServiceWorker();
  registerPublicCloudSurfaces();
  createRoot(rootElement).render(
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
