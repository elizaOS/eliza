/**
 * Keeps Applications navigation inside the owning studio: web app-shell routes
 * use /cloud-apps while the native studio retains its private /cloud/apps router.
 */
import { useLocation } from "react-router-dom";

export function useApplicationsBasePath(): string {
  const { pathname } = useLocation();
  return pathname === "/cloud-apps" || pathname.startsWith("/cloud-apps/")
    ? "/cloud-apps"
    : "/cloud/apps";
}
