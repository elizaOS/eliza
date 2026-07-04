/**
 * Sub-agent credential bridge — additive credential endpoints.
 *
 * These routes complement the existing read-only parent-context bridge
 * (`parent-context-routes.ts`) by giving a spawned coding sub-agent a way
 * to *request* a missing credential from the parent. The parent collects
 * the value from the owner via the standard REQUEST_SECRET sensitive-request
 * flow (owner-only actor policy, DM or owner-app-inline target), encrypts
 * it under a one-time symmetric key, and the child long-polls the GET
 * endpoint with the bearer token it received at scope declaration.
 *
 * Endpoints (loopback-only):
 *
 *   POST /api/coding-agents/:sessionId/credentials/request
 *     body: { credentialKeys: string[] }
 *     → { credentialScopeId, scopedToken, expiresAt, sensitiveRequestIds }
 *
 *   GET  /api/coding-agents/:sessionId/credentials/:key?token=<scopedToken>
 *     long-poll up to 5 minutes for the encrypted value, one-shot redemption.
 *     → { key, value, retrievedAt }  // value plaintext, recovered by the
 *                                   //  service's decrypt-on-retrieve
 *
 * The orchestrator wires this module via `routes.ts`. The implementation is
 * decoupled from the credential-tunnel service: callers pass a small
 * `BridgeCredentialAdapter` so the same routes can be wired against a
 * test-time mock or the production `CredentialTunnelService`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE } from "@elizaos/core";
import type { SessionInfo } from "../services/types.js";
import { TERMINAL_SESSION_STATUSES } from "../services/types.js";
import {
  emitCredentialPrompt,
  emitCredentialResolved,
} from "./credential-prompt.js";
import type { RouteContext } from "./route-utils.js";
import { parseBody, sendJson } from "./route-utils.js";

const POST_PATH = /^\/api\/coding-agents\/([^/]+)\/credentials\/request\/?$/;
const GET_PATH = /^\/api\/coding-agents\/([^/]+)\/credentials\/([^/?]+)\/?$/;

const DEFAULT_LONG_POLL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

/**
 * Machine-readable rejection reasons the credential adapter may emit
 * (`CredentialScopeError.code`). Anything outside this set is a raw
 * `error.message` from an unexpected failure and must NOT leak into the
 * structured `code` channel — it collapses to a stable `rejected`.
 */
const KNOWN_CREDENTIAL_REJECTION_CODES: ReadonlySet<string> = new Set([
  "invalid_input",
  "key_not_in_scope",
  "invalid_token",
  "unknown_scope",
  "scope_expired",
  "session_mismatch",
  "already_redeemed",
  "no_ciphertext",
]);

/**
 * Adapter surface the bridge routes need from the parent runtime. The
 * concrete implementation lives in app-core (`CredentialTunnelService`) and
 * is registered into the parent runtime out-of-band; the route layer never
 * imports it directly.
 */
export interface BridgeCredentialAdapter {
  requestCredentials(input: {
    childSessionId: string;
    credentialKeys: readonly string[];
    origin?: {
      roomId?: string;
      channelId?: string;
      source?: string;
      ownerEntityId?: string;
    };
  }): Promise<{
    credentialScopeId: string;
    scopedToken: string;
    expiresAt: number;
    sensitiveRequestIds: readonly string[];
  }>;
  tryRetrieveCredential(input: {
    childSessionId: string;
    key: string;
    scopedToken: string;
  }): Promise<
    | { status: "pending" }
    | { status: "ready"; value: string }
    | { status: "expired" }
    | { status: "rejected"; reason: string }
  >;
}

function originFromSessionMetadata(
  metadata: Record<string, unknown> | undefined,
):
  | {
      roomId?: string;
      channelId?: string;
      source?: string;
      ownerEntityId?: string;
    }
  | undefined {
  if (!metadata) return undefined;
  const roomId =
    typeof metadata.roomId === "string" && metadata.roomId.trim()
      ? metadata.roomId.trim()
      : undefined;
  const channelId =
    typeof metadata.channelId === "string" && metadata.channelId.trim()
      ? metadata.channelId.trim()
      : roomId;
  const source =
    typeof metadata.source === "string" && metadata.source.trim()
      ? metadata.source.trim()
      : undefined;
  const ownerEntityId =
    typeof metadata.userId === "string" && metadata.userId.trim()
      ? metadata.userId.trim()
      : typeof metadata.ownerEntityId === "string" &&
          metadata.ownerEntityId.trim()
        ? metadata.ownerEntityId.trim()
        : undefined;
  if (!roomId && !channelId && !source && !ownerEntityId) return undefined;
  return { roomId, channelId, source, ownerEntityId };
}

function isLoopback(remoteAddress: string | null | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}

function decodeSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing; a malformed percent-encoding
    // is an explicit invalid segment (null), rejected by the caller.
    return null;
  }
  if (!decoded || decoded.includes("/") || decoded.includes("..")) return null;
  return decoded;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve the per-runtime credential adapter. The orchestrator registers it
 * as a runtime service under the well-known key below. Returning null lets
 * the routes respond with 503 cleanly when the parent runtime doesn't
 * support credential tunneling (e.g. a stripped-down test harness).
 */
function getAdapter(ctx: RouteContext): BridgeCredentialAdapter | null {
  // Single-step cast: BridgeCredentialAdapter is a plain interface without the
  // Service base class, so we cannot use the getService<T> generic, but the
  // types don't conflict and one cast suffices.
  return (ctx.runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_ADAPTER_SERVICE) ??
    null) as BridgeCredentialAdapter | null;
}

/**
 * Verify the sessionId names a real, active sub-agent session owned by this
 * parent runtime before issuing a credential request for it.
 *
 * Without this, the POST only gated on loopback — so ANY local process could
 * trigger the owner-facing REQUEST_SECRET approval flow (and mint a scopedToken)
 * for an arbitrary, attacker-chosen sessionId. Mirrors the read-only
 * parent-context bridge's getSession/isActiveSession gate so the credential
 * POST can only act on a session that genuinely exists and is still running.
 */
async function resolveActiveSession(
  ctx: RouteContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const session = (await ctx.acpService?.getSession(sessionId)) ?? null;
  if (!session) return null;
  if (TERMINAL_SESSION_STATUSES.has(String(session.status))) return null;
  return session;
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  sessionId: string,
): Promise<void> {
  const adapter = getAdapter(ctx);
  if (!adapter) {
    sendJson(
      res,
      { error: "credential bridge unavailable", code: "no_adapter" },
      503,
    );
    return;
  }
  // Ownership gate: only issue a credential request for a session that is real
  // and active in this parent runtime. Loopback alone does not prove the caller
  // owns the session — without this, any local process could trigger the
  // owner-facing approval flow for an arbitrary sessionId.
  const session = await resolveActiveSession(ctx, sessionId);
  if (!session) {
    sendJson(
      res,
      {
        error: "no active sub-agent session for this id in this parent runtime",
        code: "session_not_active",
      },
      410,
    );
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await parseBody(req);
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing; a malformed request body is an
    // explicit invalid result (400), never a fabricated success.
    sendJson(
      res,
      {
        error: error instanceof Error ? error.message : "invalid body",
        code: "invalid_body",
      },
      400,
    );
    return;
  }
  const rawKeys = body.credentialKeys;
  if (
    !Array.isArray(rawKeys) ||
    rawKeys.length === 0 ||
    rawKeys.some((k) => typeof k !== "string" || k.trim().length === 0)
  ) {
    sendJson(
      res,
      {
        error: "credentialKeys must be a non-empty array of strings",
        code: "invalid_credential_keys",
      },
      400,
    );
    return;
  }
  const result = await adapter.requestCredentials({
    childSessionId: sessionId,
    credentialKeys: rawKeys as readonly string[],
    origin: originFromSessionMetadata(session.metadata),
  });
  // #8907/#10317: surface the pending request in the origin task thread so
  // `SensitiveRequestBlock` renders an inline tunnel-routed secure form (AC1).
  // Best-effort; never blocks the credential bridge response. The scoped token
  // is NOT forwarded — only the scope id + child session id, so the submitted
  // value tunnels to this child.
  await emitCredentialPrompt({
    runtime: ctx.runtime,
    metadata: session.metadata,
    credentialKeys: rawKeys as readonly string[],
    label: session.name,
    credentialScopeId: result.credentialScopeId,
    childSessionId: sessionId,
    expiresAt: result.expiresAt,
  });
  sendJson(res, {
    credentialScopeId: result.credentialScopeId,
    scopedToken: result.scopedToken,
    expiresAt: result.expiresAt,
    sensitiveRequestIds: [...result.sensitiveRequestIds],
  });
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  sessionId: string,
  key: string,
): Promise<void> {
  const adapter = getAdapter(ctx);
  if (!adapter) {
    sendJson(
      res,
      { error: "credential bridge unavailable", code: "no_adapter" },
      503,
    );
    return;
  }
  // Defense-in-depth ownership gate, mirroring handlePost: only redeem a
  // credential for a session that is real and still active in this parent
  // runtime. A scopedToken can only exist if a POST already passed this gate,
  // but re-checking here keeps both halves of the bridge consistent and closes
  // the window where a session goes terminal mid-redemption.
  const session = await resolveActiveSession(ctx, sessionId);
  if (!session) {
    sendJson(
      res,
      {
        error: "no active sub-agent session for this id in this parent runtime",
        code: "session_not_active",
      },
      410,
    );
    return;
  }
  const url = new URL(req.url ?? "", "http://localhost");
  const scopedToken = (url.searchParams.get("token") ?? "").trim();
  if (!scopedToken) {
    sendJson(
      res,
      { error: "missing token query parameter", code: "missing_token" },
      400,
    );
    return;
  }
  const deadline = Date.now() + DEFAULT_LONG_POLL_MS;
  // Long-poll loop. Bail early on expired / rejected — these are terminal.
  // Keep client-disconnected detection cheap: we short-circuit the loop if
  // the response has already been destroyed.
  while (!res.writableEnded && Date.now() < deadline) {
    const outcome = await adapter.tryRetrieveCredential({
      childSessionId: sessionId,
      key,
      scopedToken,
    });
    if (outcome.status === "ready") {
      // #8907: tell the origin thread the task is unblocked (best-effort).
      await emitCredentialResolved({
        runtime: ctx.runtime,
        metadata: session.metadata,
        key,
        label: session.name,
      });
      sendJson(res, {
        key,
        value: outcome.value,
        retrievedAt: Date.now(),
      });
      return;
    }
    if (outcome.status === "expired") {
      sendJson(res, { error: "scope expired", code: "scope_expired" }, 410);
      return;
    }
    if (outcome.status === "rejected") {
      // `reason` may be a raw error.message for an unexpected failure; keep the
      // free text in `error` but only pass a KNOWN adapter code into `code`.
      const code = KNOWN_CREDENTIAL_REJECTION_CODES.has(outcome.reason)
        ? outcome.reason
        : "rejected";
      sendJson(res, { error: outcome.reason, code }, 403);
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  if (!res.writableEnded) {
    sendJson(
      res,
      { error: "credential not delivered before deadline", code: "timeout" },
      504,
    );
  }
}

/**
 * Dispatcher for the credential bridge routes. Returns true when the path
 * matches one of our patterns (whether or not the response is a success).
 *
 * `routes.ts` calls this after parent-context routes and before generic
 * `:agentId` routes.
 */
export async function handleBridgeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  ctx: RouteContext,
): Promise<boolean> {
  const postMatch = pathname.match(POST_PATH);
  const getMatch = postMatch ? null : pathname.match(GET_PATH);
  if (!postMatch && !getMatch) return false;

  if (!isLoopback(req.socket.remoteAddress)) {
    sendJson(
      res,
      {
        error: "credential bridge is loopback-only",
        code: "loopback_only",
      },
      403,
    );
    return true;
  }

  const method = (req.method ?? "").toUpperCase();
  if (postMatch) {
    if (method !== "POST") {
      sendJson(
        res,
        { error: "expected POST", code: "method_not_allowed" },
        405,
      );
      return true;
    }
    const sessionId = decodeSegment(postMatch[1]);
    if (!sessionId) {
      sendJson(
        res,
        { error: "invalid session id", code: "invalid_session_id" },
        400,
      );
      return true;
    }
    await handlePost(req, res, ctx, sessionId);
    return true;
  }
  if (getMatch) {
    if (method !== "GET") {
      sendJson(res, { error: "expected GET", code: "method_not_allowed" }, 405);
      return true;
    }
    const sessionId = decodeSegment(getMatch[1]);
    const key = decodeSegment(getMatch[2]);
    if (!sessionId || !key) {
      sendJson(
        res,
        { error: "invalid path segment", code: "invalid_path" },
        400,
      );
      return true;
    }
    await handleGet(req, res, ctx, sessionId, key);
    return true;
  }
  return false;
}
