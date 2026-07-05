/**
 * Redirect stub for the retired console Apps surface. App management moved into
 * the Eliza app (agent-driven), so the console no longer surfaces
 * `/dashboard/apps`; this element — registered after the applications module's
 * import-time self-registration so it wins on the same paths — sends a stale
 * link to the dashboard. The Applications components stay put: the native eliza
 * app (`NativeAppsStudio`) still imports them.
 */

import { Navigate } from "react-router-dom";

export default function AppsMovedRoute() {
  return <Navigate to="/dashboard" replace />;
}
