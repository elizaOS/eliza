/**
 * Compatibility redirect for retired `/cloud/security` bookmarks. Account
 * security is no longer a separate consumer page; backend-issued permission
 * recovery links keep their narrower `/cloud/security/permissions` route.
 */

import { Navigate } from "react-router-dom";

export default function SecurityMovedRoute(): React.JSX.Element {
  return <Navigate to="/cloud/account" replace />;
}
