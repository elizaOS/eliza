/**
 * Public-site host detection shared by the cloud router shell and auth entry
 * flow. These hosts serve marketing/auth pages but have no same-origin agent
 * backend; managed app and dedicated-agent hosts are deliberately excluded.
 */
import { classifyElizaHostname } from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";

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
  // bake the flag (packages/app/scripts/forced-host-mode-guard.ts).
  if (import.meta.env?.VITE_FORCE_APEX_CONSOLE === "true") return true;
  return isApexControlPlaneHostname(window.location.hostname);
}
