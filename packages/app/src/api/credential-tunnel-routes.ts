/**
 * Mounts POST `/api/credential-tunnel` (and the legacy `/submit` alias): the
 * owner-only endpoint that tunnels a single secret to a sub-agent session.
 * Requires the OWNER role, validates the child-session/scope identifiers and
 * key against strict allow-lists, then delegates to the runtime's
 * SubAgentCredentialBridge service. Translates each `CredentialScopeError.code`
 * to its HTTP status (invalid→400, unknown→404, expired→410, mismatch/redeemed
 * →403, no_ciphertext→409) and returns 503 when no bridge is registered.
 */
import type http from "node:http";
import {
  CredentialScopeError,
  SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  type SubAgentCredentialBridge,
} from "../services/credential-tunnel-service";
import { ensureRouteMinRole } from "./auth";
import type { CompatRuntimeState } from "./compat-route-shared";
import { readCompatJsonBody } from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

const ROUTES = new Set([
  "/api/credential-tunnel",
  "/api/credential-tunnel/submit",
]);
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]{1,256}$/;

function requiredString(
  body: Record<string, unknown>,
  key: string,
  re: RegExp,
): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && re.test(trimmed) ? trimmed : null;
}

function errorStatus(error: CredentialScopeError): number {
  switch (error.code) {
    case "invalid_input":
    case "key_not_in_scope":
    case "invalid_token":
      return 400;
    case "unknown_scope":
      return 404;
    case "scope_expired":
      return 410;
    case "session_mismatch":
    case "already_redeemed":
      return 403;
    case "no_ciphertext":
      return 409;
  }
}

export async function handleCredentialTunnelRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!ROUTES.has(pathname)) return false;

  if (method !== "POST") {
    sendJsonError(res, 405, "method not allowed");
    return true;
  }
  if (!(await ensureRouteMinRole(req, res, state, "OWNER"))) return true;

  const body = await readCompatJsonBody(req, res);
  if (!body) return true;
  const childSessionId = requiredString(body, "childSessionId", SAFE_ID_RE);
  const credentialScopeId = requiredString(
    body,
    "credentialScopeId",
    SAFE_ID_RE,
  );
  const key = requiredString(body, "key", SAFE_KEY_RE);
  const value = typeof body.value === "string" ? body.value : null;
  if (!childSessionId || !credentialScopeId || !key || !value) {
    sendJsonError(
      res,
      400,
      "childSessionId, credentialScopeId, key, and non-empty value are required",
    );
    return true;
  }

  const bridge = state.current?.getService?.(
    SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
  ) as SubAgentCredentialBridge | null | undefined;
  if (!bridge) {
    sendJson(res, 503, {
      ok: false,
      error: "credential bridge unavailable",
      code: "no_adapter",
    });
    return true;
  }

  try {
    await bridge.tunnelCredential({
      childSessionId,
      credentialScopeId,
      key,
      value,
    });
    sendJson(res, 200, {
      ok: true,
      credentialScopeId,
      childSessionId,
      key,
    });
  } catch (error) {
    if (error instanceof CredentialScopeError) {
      sendJson(res, errorStatus(error), {
        ok: false,
        error: error.code,
        code: error.code,
      });
      return true;
    }
    sendJsonError(res, 500, "credential_tunnel_failed");
  }
  return true;
}
