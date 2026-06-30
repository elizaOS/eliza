/**
 * Owner-authenticated credential-tunnel submit route.
 *
 *   POST /api/credential-tunnel/submit
 *     body: { credentialScopeId, childSessionId, key, value }
 *     → { ok: true }
 *
 * This is the redemption seam for the in-chat / DM `SensitiveRequestBlock`:
 * when a secret request carries `delivery.tunnel`, the owner's submitted value
 * is routed here instead of to the agent secret store. The handler resolves the
 * parent runtime's `SubAgentCredentialBridge` service and calls
 * `tunnelCredential`, which encrypts the value under the one-shot scope key so
 * the blocked child can redeem it via the loopback bridge GET.
 *
 * Ownership is enforced by the caller (`ensureRouteMinRole(..., "OWNER")` in
 * `server.ts`) — `owner_only` actor policy. Scope membership is enforced by the
 * tunnel service (`key_not_in_scope`). The value is never logged and never
 * written to the long-term secret store; the two submit paths are mutually
 * exclusive by construction (this route never touches `updateSecrets`).
 */

import type http from "node:http";
import type { Service, SubAgentCredentialBridge } from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CompatRuntimeState } from "./compat-route-shared.js";
import { readCompatJsonBody } from "./compat-route-shared.js";
import { CredentialScopeError } from "../services/credential-tunnel-service.js";
import { sendJson } from "./response.js";

const SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE = "SubAgentCredentialBridge";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Map a tunnel-service error code to an HTTP status. Terminal scope/auth
 * failures surface as 4xx; the value is never echoed back.
 */
function statusForScopeError(code: CredentialScopeError["code"]): number {
  switch (code) {
    case "scope_expired":
      return 410;
    case "unknown_scope":
      return 404;
    case "session_mismatch":
    case "key_not_in_scope":
    case "already_redeemed":
      return 403;
    default:
      return 400;
  }
}

export async function handleCredentialTunnelRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  method: string,
  pathname: string,
): Promise<boolean> {
  if (method !== "POST" || pathname !== "/api/credential-tunnel/submit") {
    return false;
  }

  const runtime = state.current;
  if (!runtime) {
    sendJson(res, 503, {
      error: "credential bridge unavailable",
      code: "no_adapter",
    });
    return true;
  }

  const bridge = runtime.getService<Service & SubAgentCredentialBridge>(
    SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  );
  if (!bridge) {
    sendJson(res, 503, {
      error: "credential bridge unavailable",
      code: "no_adapter",
    });
    return true;
  }

  const body = await readCompatJsonBody(req, res);
  if (!body) return true; // readCompatJsonBody already sent the error response

  const { credentialScopeId, childSessionId, key, value } = body;
  if (
    !nonEmptyString(credentialScopeId) ||
    !nonEmptyString(childSessionId) ||
    !nonEmptyString(key) ||
    !nonEmptyString(value)
  ) {
    sendJson(res, 400, {
      error:
        "credentialScopeId, childSessionId, key and value are all required",
      code: "invalid_body",
    });
    return true;
  }

  try {
    await bridge.tunnelCredential({
      childSessionId: childSessionId.trim(),
      credentialScopeId: credentialScopeId.trim(),
      key: key.trim(),
      value,
    });
  } catch (error) {
    if (error instanceof CredentialScopeError) {
      // Log code + scope id only — never the value.
      logger.warn(
        `[credential-tunnel] submit rejected (${error.code}) for scope ${credentialScopeId}`,
      );
      sendJson(res, statusForScopeError(error.code), {
        error: error.message,
        code: error.code,
      });
      return true;
    }
    throw error;
  }

  sendJson(res, 200, { ok: true });
  return true;
}
