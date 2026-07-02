/**
 * Browser fixture for the #11341 cloud-surface unification visual e2e.
 *
 * Two modes, selected by query param:
 *
 * - default: registers every cloud surface (the real `registerAllCloudSurfaces`
 *   boot hook) and mounts the real {@link CloudRouterShell} with a probe
 *   catch-all, so the harness can drive the legacy `/dashboard/*` deep links
 *   and prove each one redirects to its canonical `/settings#<section>` home
 *   (query preserved, hash resolving to a registered settings section).
 *
 * - `?surface=<billing|monetization|security|api-keys|account>`: mounts that
 *   surface's REAL registered settings section (the exact zero-prop component
 *   `registerCloudSettingsSections` hands to the settings registry), fetching
 *   real data from the mock cloud stack proxied on the page origin.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { registerAllCloudSurfaces } from "../register-all";
import {
  CloudAccountSection,
  CloudApiKeysSection,
  CloudBillingSection,
  CloudMonetizationSection,
  CloudSecuritySection,
} from "../settings/sections";
import { CloudRouterShell } from "../shell/CloudRouterShell";
// The settings hash contract: the alias map + section registry the tab app
// uses to open a section from `/settings#<hash>`.
import { readSettingsHashSection } from "../../components/settings/settings-sections";

registerAllCloudSurfaces();

/**
 * Catch-all probe standing in for the tab/view app: shows where the router
 * landed and which settings section the app-side hash contract resolves.
 */
function CatchAllProbe() {
  // Re-read on hashchange — same-document hash navigation does not re-render
  // otherwise (SettingsView keeps an identical listener).
  const [, setTick] = useState(0);
  useEffect(() => {
    const onHash = () => setTick((t) => t + 1);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const { pathname, search, hash } = window.location;
  const section = readSettingsHashSection();
  return (
    <div className="min-h-screen bg-black p-10 font-mono text-sm text-white">
      <h1 className="mb-6 text-lg font-semibold">
        app catch-all (tab/view app placeholder)
      </h1>
      <dl className="space-y-2">
        <div>
          <dt className="text-white/50">location</dt>
          <dd data-testid="probe-location">{`${pathname}${search}${hash}`}</dd>
        </div>
        <div>
          <dt className="text-white/50">resolved settings section</dt>
          <dd data-testid="probe-section">{section ?? "(none)"}</dd>
        </div>
      </dl>
    </div>
  );
}

const SURFACES: Record<string, () => React.JSX.Element> = {
  billing: CloudBillingSection,
  monetization: CloudMonetizationSection,
  security: CloudSecuritySection,
  "api-keys": CloudApiKeysSection,
  account: CloudAccountSection,
};

function Fixture() {
  const surface = new URLSearchParams(window.location.search).get("surface");
  if (surface) {
    const Section = SURFACES[surface];
    if (!Section) {
      return <div data-testid="fixture-error">unknown surface: {surface}</div>;
    }
    return (
      <div className="min-h-screen bg-black p-6 text-white">
        <main className="mx-auto max-w-5xl" data-testid={`surface-${surface}`}>
          <Section />
        </main>
      </div>
    );
  }
  return <CloudRouterShell appElement={<CatchAllProbe />} />;
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root missing");
createRoot(rootEl).render(<Fixture />);
