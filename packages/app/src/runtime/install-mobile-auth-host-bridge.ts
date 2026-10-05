/** Mobile host composes DB-backed owner sessions before the portable agent boots. */
import {
  getAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import {
  resolveAuthorizedRouteRole,
  resolveSessionTokenRole,
} from "../api/auth";
import { subscribeSessionRevocations } from "../api/auth/sessions";
import { handleAuthPairingCompatRoutes } from "../api/auth-pairing-routes";
import { handleAuthSessionRoutes } from "../api/auth-session-routes";
export function installMobileAuthHostBridge(): void {
  setAgentHostBridge({
    ...getAgentHostBridge(),
    handleAuthRoutes: async (req, res, runtime) => {
      const state = {
        current: runtime,
        pendingAgentName: null,
        pendingRestartReasons: [],
      };
      return (
        (await handleAuthSessionRoutes(req, res, state)) ||
        (await handleAuthPairingCompatRoutes(req, res, state))
      );
    },
    resolveHttpRequestAuthorization: async (req, runtime, options) => {
      const result = await resolveAuthorizedRouteRole(req, {
        ...options,
        state: { current: runtime },
      });
      return result.ok
        ? {
            ok: true,
            role: result.role,
            ...(result.identityId ? { identityId: result.identityId } : {}),
            ...(result.principal ? { principal: result.principal } : {}),
          }
        : { ok: false, role: "NONE" };
    },
    resolveSessionTokenAuthorization: async (token, runtime) => {
      const result = await resolveSessionTokenRole(token, {
        state: { current: runtime },
        scope: "mobileHost/sessionTokenAuthorization",
      });
      return result
        ? {
            ok: true,
            role: result.role,
            ...(result.identityId ? { identityId: result.identityId } : {}),
          }
        : { ok: false, role: "NONE" };
    },
    subscribeSessionRevocations,
  });
}
