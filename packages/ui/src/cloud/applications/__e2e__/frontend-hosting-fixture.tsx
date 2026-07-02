/**
 * Browser fixture for the frontend-hosting visual e2e (#10690/#10725).
 * Mounts the REAL dashboard pieces — `CloudI18nProvider`, the page frame the
 * Applications detail page uses, `AppFrontendHosting`, and the real sonner
 * `<Toaster/>` so toasts are actual pixels. The host page seeds
 * `window.__W3_APP_ID__` and the steward token in localStorage before this
 * bundle executes; every API call rides the real cloud `api-client` against
 * the live mock cloud stack proxied on the page origin.
 */

import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { CloudI18nProvider } from "../../shell/CloudI18nProvider";
import { AppFrontendHosting } from "../components/app-frontend-hosting";

declare global {
  interface Window {
    __W3_APP_ID__: string;
  }
}

function Fixture() {
  return (
    <CloudI18nProvider initialLang="en">
      <div className="min-h-screen bg-bg font-body text-txt">
        <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
          <div>
            <h1 className="text-lg font-semibold text-txt">w3-hosting-e2e</h1>
            <p className="text-xs text-muted">
              Applications › w3-hosting-e2e › Hosting
            </p>
          </div>
          <AppFrontendHosting appId={window.__W3_APP_ID__} />
        </main>
        <Toaster position="bottom-right" />
      </div>
    </CloudI18nProvider>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root missing");
createRoot(rootEl).render(<Fixture />);
