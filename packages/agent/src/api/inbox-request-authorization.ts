/** Resolve the authenticated caller authority used by inbox connector sends. */
import type http from "node:http";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";
import { resolveBoundaryRole } from "./server-helpers-auth.ts";

export function resolveInboxRequestAuthorization(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
  hostAuthorization: AgentHttpRequestAuthorization,
): AgentHttpRequestAuthorization {
  if (resolveBoundaryRole(req) === "OWNER") {
    return { ok: true, role: "OWNER" };
  }
  if (hostAuthorization.ok) {
    return hostAuthorization;
  }

  const registeredAccess = resolveRegisteredTokenRoleAccess(req);
  if (
    registeredAccess &&
    (registeredAccess.isAdmin ||
      registeredAccess.isRouteInScope(method.toUpperCase(), pathname))
  ) {
    return {
      ok: true,
      role: registeredAccess.worldRole,
      principal: registeredAccess.principal,
    };
  }
  return hostAuthorization;
}
