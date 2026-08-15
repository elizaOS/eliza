/**
 * Redirect stub for the retired console Apps surface. App management moved into
 * the Eliza app (agent-driven), so the console no longer surfaces
 * `/cloud/apps`; this element — registered after the applications module's
 * import-time self-registration so it wins on the same paths — sends a stale
 * link to the dashboard. The Applications components stay put: the native eliza
 * app (`NativeAppsStudio`) still imports them. The redirect runs through the
 * shell privilege channel because Cloud surfaces execute under the realm guard.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { runAsPrivilegedShell } from "../../surface-realm-channel";

export default function AppsMovedRoute() {
  const navigate = useNavigate();

  useEffect(() => {
    runAsPrivilegedShell(() => navigate("/cloud", { replace: true }));
  }, [navigate]);

  return null;
}
