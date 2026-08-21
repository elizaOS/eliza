/**
 * Compatibility redirect for retired `/cloud/security` bookmarks. Account
 * security is no longer a separate consumer page; backend-issued permission
 * recovery links keep their narrower `/cloud/security/permissions` route.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { runAsPrivilegedShell } from "../../surface-realm-channel";

export default function SecurityMovedRoute(): null {
  const navigate = useNavigate();

  useEffect(() => {
    runAsPrivilegedShell(() => navigate("/cloud/account", { replace: true }));
  }, [navigate]);

  return null;
}
