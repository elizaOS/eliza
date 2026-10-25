import type http from "node:http";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";
import {
  isDirectOwnerApiTokenAuthorized,
  isServerTokenAuthorized,
  resolveBoundaryRole,
} from "./server-helpers-auth.ts";

/** Raw trajectory context is an owner surface, not a session-tier read. */
export function isTrajectoryOwnerRequest(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
  hostAuthorization: AgentHttpRequestAuthorization,
  allowAmbientLocal = true,
): boolean {
  if (isServerTokenAuthorized(req)) return false;
  if (hostAuthorization.ok) return hostAuthorization.role === "OWNER";

  const access = resolveRegisteredTokenRoleAccess(req);
  if (access) {
    return (
      access.worldRole === "OWNER" &&
      (access.isAdmin || access.isRouteInScope(method, pathname))
    );
  }
  if (!allowAmbientLocal) return isDirectOwnerApiTokenAuthorized(req);
  return resolveBoundaryRole(req) === "OWNER";
}
