/**
 * Apex control-plane host detection, shared by the cloud router shell (the
 * never-boot-the-agent-app guard), the console chrome, and the post-login
 * default landing. These hosts serve the console UI but have no same-origin
 * agent backend; per-agent `<id>.elizacloud.ai` subdomains are NOT in the set
 * and boot their real runtime.
 */

import { ELIZA_CLOUD_CONTROL_PLANE_HOSTS } from "../../utils/cloud-agent-base";

/** Control-plane hosts minus the API origins (api. / api-staging.), which
 * never serve the UI shell, and minus the app hosts (app. / app-staging.),
 * which serve the agent chat app — not the console. The app hosts sit in
 * ELIZA_CLOUD_CONTROL_PLANE_HOSTS only so per-agent `<id>.elizacloud.ai`
 * detection doesn't misread them as dedicated agent subdomains; classifying
 * them as apex here would stop the agent app from ever booting on them (see
 * AppCatchAllRoute) and send their post-login default to /dashboard. */
export const APEX_UI_CONTROL_PLANE_HOSTS = new Set(
  [...ELIZA_CLOUD_CONTROL_PLANE_HOSTS].filter((h) => !/^(api|app)[.-]/.test(h)),
);

export function isApexControlPlaneHost(): boolean {
  if (typeof window === "undefined") return false;
  // Dev-only apex emulation: localhost is never a control-plane host, so the
  // console's apex behavior (root → /dashboard, unauth → /login, agent app
  // never boots) is otherwise untestable in `vite dev`. Vite inlines the env
  // read on literal access; production builds ship without the flag.
  if (import.meta.env?.VITE_FORCE_APEX_CONSOLE === "true") return true;
  return APEX_UI_CONTROL_PLANE_HOSTS.has(
    window.location.hostname.toLowerCase(),
  );
}
