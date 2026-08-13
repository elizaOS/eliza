/**
 * Public-site host detection shared by the cloud router shell and auth entry
 * flow. These hosts serve marketing/auth pages but have no same-origin agent
 * backend; managed app and dedicated-agent hosts are deliberately excluded.
 */

import {
  classifyElizaHostname,
  ELIZA_DOMAIN_CONTRACTS,
  LEGACY_ELIZA_DOMAIN_CONTRACTS,
} from "@elizaos/shared";

/** Control-plane hosts minus the API origins (api. / api-staging.), which
 * never serve the UI shell, and minus the app hosts (app. / app-staging.),
 * which serve the agent chat app — not the console. The app hosts sit in
 * ELIZA_CLOUD_CONTROL_PLANE_HOSTS only so canonical and legacy per-agent
 * subdomain detection doesn't misread them as dedicated agent hosts;
 * classifying them as apex here would stop the agent app from ever booting on
 * them (see AppCatchAllRoute) and send their post-login default to the in-app
 * /cloud view. */
export const APEX_UI_CONTROL_PLANE_HOSTS = new Set([
  new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname,
  new URL(ELIZA_DOMAIN_CONTRACTS.staging.marketingOrigin).hostname,
  `www.${new URL(ELIZA_DOMAIN_CONTRACTS.production.marketingOrigin).hostname}`,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.production.marketingHostnames,
  ...LEGACY_ELIZA_DOMAIN_CONTRACTS.staging.marketingHostnames,
]);

/** Pure public-site hostname decision for the host-role route matrix. */
export function isApexControlPlaneHostname(hostname: string): boolean {
  const role = classifyElizaHostname(hostname).role;
  return role === "marketing" || role === "legacy-marketing";
}

export function isApexControlPlaneHost(): boolean {
  if (typeof window === "undefined") return false;
  // Dev-only apex emulation: localhost is never a control-plane host, so the
  // marketing-host behavior (app path → /cloud, unauth → /login, agent app
  // never boots) is otherwise untestable in `vite dev`. Vite inlines the env
  // read on literal access, and production-mode packages/app builds refuse to
  // bake the flag (packages/app/scripts/forced-host-mode-guard.mjs).
  if (import.meta.env?.VITE_FORCE_APEX_CONSOLE === "true") return true;
  return isApexControlPlaneHostname(window.location.hostname);
}
