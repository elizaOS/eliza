/**
 * Browser fixture for the #11341 cloud-surface unification visual e2e.
 *
 * Two modes, selected by query param:
 *
 * - default: registers every cloud surface (the real `registerAllCloudSurfaces`
 *   boot hook) and mounts the real {@link CloudRouterShell} with an app-shell
 *   boundary probe. The harness verifies `/cloud/*` management routes delegate
 *   to the normal app, legacy URLs normalize before that delegation, and the
 *   `/settings#<section>` hash contract still resolves for compatibility.
 *
 * - `?surface=<billing|monetization|security|api-keys|account>`: mounts that
 *   surface's REAL registered settings section (the exact zero-prop component
 *   `registerCloudSettingsSections` hands to the settings registry), fetching
 *   real data from the mock cloud stack proxied on the page origin.
 *
 * Bundled as IIFE for the e2e harness — no top-level await. Full registration
 * uses the synchronous {@link registerAllCloudSurfaces} from `../register-all`
 * (the preserved develop contract).
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

// Synchronous full registration — required for IIFE output format (no TLA).
registerAllCloudSurfaces();

/**
 * Boundary probe standing in for the tab/view app. The full renderer's app
 * chrome is covered by packages/app Playwright; this fixture proves the cloud
 * router delegates to that boundary without mounting standalone console chrome.
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
    <div
      className="min-h-dvh bg-black p-10 font-mono text-sm text-white"
      data-app-shell-root=""
    >
      <h1 className="mb-6 text-lg font-semibold">
        managed Cloud app boundary
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
      <div className="min-h-dvh bg-black p-6 text-white">
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
