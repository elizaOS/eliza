/** Resolve the authenticated caller authority used by inbox connector sends. */
import type http from "node:http";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { resolveRegisteredTokenRoleAccess } from "./boundary-role-resolver.ts";
import { getAuthenticatedInProcessAuthorization } from "./in-process-request.ts";
import { resolveBoundaryRole } from "./server-helpers-auth.ts";

export function resolveInboxRequestAuthorization(
  req: http.IncomingMessage,
  method: string,
  pathname: string,
  hostAuthorization: AgentHttpRequestAuthorization,
): AgentHttpRequestAuthorization {
  // A scoped self-dispatch retains its verified caller; a root helper header
  // cannot replace that identity or promote a narrower role.
  const inherited = getAuthenticatedInProcessAuthorization(req);
  if (inherited) return inherited;
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
