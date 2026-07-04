/**
 * Stub module that stands in for the real cloud router shell in builds that
 * exclude the cloud/web dashboard surface. See the component doc below for the
 * passthrough contract.
 */
import type { ReactNode } from "react";

/**
 * Build-time stub for the cloud router shell, used when `ELIZA_DISABLE_WEB_SHELL=1`
 * excludes the cloud surface from the build (e.g. the ui-smoke lane, which
 * exercises the agent app, not the cloud dashboard). The shell normally wraps the
 * app with the cloud / auth / public routes; with the cloud surface excluded it is
 * a passthrough that just renders the agent app.
 */
export function CloudRouterShell({
  appElement,
}: {
  appElement: ReactNode;
}): ReactNode {
  return appElement;
}
