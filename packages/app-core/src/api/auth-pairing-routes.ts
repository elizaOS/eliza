/**
 * Mounts the device-pairing and first-run/auth-status compat HTTP routes:
 * `GET /api/first-run/status`, `GET /api/auth/status`, `GET /api/auth/pair-code`,
 * `POST /api/auth/guest-pair-code`, and `POST /api/auth/pair`. Pairing intent
 * is fixed by server-held code state: the rotating operator code is owner
 * access, while an owner-authenticated guest invitation is always USER access.
 * The short-lived codes live in process
 * memory with a TTL and is disclosed only to trusted-loopback callers;
 * `POST /api/auth/pair` rate-limits by client IP, validates the code, and (when
 * a runtime DB is available) mints a revocable machine session bound to the
 * owner or a `paired-device` identity — returning the session id rather than the
 * forever-valid static API token. `/api/auth/status` is a public, secret-free
 * probe the dashboard uses to decide whether to show the pairing/login UI.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import { readAliasedEnv } from "@elizaos/shared/utils/env";
import { AuthStore } from "../services/auth-store";
import {
  createMachineSession,
  denyOnAuthStoreError,
  findActiveSession,
  parseSessionCookie,
} from "./auth/sessions";
import {
  ensureRouteAuthorized,
  ensureRouteMinRole,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth.ts";
import {
  type CompatRuntimeState,
  getCompatDrizzleDb,
  hasCompatPersistedFirstRunState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";
import { isCloudProvisioned } from "./server-first-run-helpers";

// ---------------------------------------------------------------------------
// Pairing state & helpers
// ---------------------------------------------------------------------------

// Remote operators often retrieve the code from a service journal before
// switching devices to the public dashboard. The longer window accommodates
// that handoff while one-time consumption and the attempt limiter remain the
// primary replay and guessing controls.
const PAIRING_TTL_MS = 60 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let pairingCode: string | null = null;
let pairingExpiresAt = 0;
let pairingInstanceId = crypto.randomUUID();
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();
const guestPairingInvites = new Map<string, { expiresAt: number }>();

export const AUTH_PAIRING_ERROR_CODES = {
  invalid: "PAIRING_INVALID",
  expired: "PAIRING_EXPIRED",
  disabled: "PAIRING_DISABLED",
  notReady: "PAIRING_NOT_READY",
  instanceMismatch: "PAIRING_INSTANCE_MISMATCH",
  rateLimited: "PAIRING_RATE_LIMITED",
  sessionFailed: "PAIRING_SESSION_FAILED",
} as const;

type AuthPairingErrorCode =
  (typeof AUTH_PAIRING_ERROR_CODES)[keyof typeof AUTH_PAIRING_ERROR_CODES];

function sendPairingError(
  res: http.ServerResponse,
  status: number,
  code: AuthPairingErrorCode,
  error: string,
): void {
  sendJsonResponse(res, status, {
    error,
    code,
    instanceId: pairingInstanceId,
  });
}

// Periodic sweep to prevent unbounded memory growth
const PAIRING_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const pairingSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pairingAttempts) {
    if (now > entry.resetAt) {
      pairingAttempts.delete(key);
    }
  }
  for (const [digest, invite] of guestPairingInvites) {
    if (now > invite.expiresAt) guestPairingInvites.delete(digest);
  }
}, PAIRING_SWEEP_INTERVAL_MS);
if (typeof pairingSweepTimer === "object" && "unref" in pairingSweepTimer) {
  pairingSweepTimer.unref();
}

export function _resetAuthPairingStateForTests(): void {
  pairingCode = null;
  pairingExpiresAt = 0;
  pairingAttempts.clear();
  guestPairingInvites.clear();
}

/** Simulates the process-identity change a restart or a different replica causes. */
export function _rotateAuthPairingInstanceForTests(): string {
  pairingCode = null;
  pairingExpiresAt = 0;
  guestPairingInvites.clear();
  pairingInstanceId = crypto.randomUUID();
  return pairingInstanceId;
}

function pairingEnabled(): boolean {
  return (
    Boolean(getCompatApiToken()) &&
    readAliasedEnv("ELIZA_PAIRING_DISABLED") !== "1" &&
    !isCloudProvisioned()
  );
}

function normalizePairingCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

function generatePairingCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i += 1) {
    raw += PAIRING_ALPHABET[crypto.randomInt(0, PAIRING_ALPHABET.length)];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function pairingCodeDigest(code: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizePairingCode(code))
    .digest("hex");
}

function createGuestPairingInvite(): {
  code: string;
  expiresAt: number;
  instanceId: string;
} {
  let code = generatePairingCode();
  while (
    (pairingCode &&
      tokenMatches(
        normalizePairingCode(pairingCode),
        normalizePairingCode(code),
      )) ||
    guestPairingInvites.has(pairingCodeDigest(code))
  ) {
    code = generatePairingCode();
  }
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  guestPairingInvites.set(pairingCodeDigest(code), { expiresAt });
  return { code, expiresAt, instanceId: pairingInstanceId };
}

function ensurePairingCode(): string | null {
  if (!pairingEnabled()) {
    return null;
  }

  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    logger.warn(
      `[api] Pairing code for remote devices: ${pairingCode} (valid for 60 minutes)`,
    );
  }

  return pairingCode;
}

export function ensureAuthPairingCodeForRemoteAccess(): {
  code: string;
  expiresAt: number;
  instanceId: string;
} | null {
  const code = ensurePairingCode();
  return code
    ? { code, expiresAt: pairingExpiresAt, instanceId: pairingInstanceId }
    : null;
}

async function requestHasActiveSession(
  req: http.IncomingMessage,
  store: import("../services/auth-store").AuthStore,
): Promise<boolean> {
  const cookieSessionId = parseSessionCookie(req);
  if (cookieSessionId) {
    const session = await findActiveSession(store, cookieSessionId).catch(
      denyOnAuthStoreError("authenticatePairingRequest/cookieSession"),
    );
    if (session) return true;
  }

  const bearer = getProvidedApiToken(req);
  if (bearer) {
    const session = await findActiveSession(store, bearer).catch(
      denyOnAuthStoreError("authenticatePairingRequest/bearerSession"),
    );
    if (session) return true;
  }

  return false;
}

function rateLimitPairing(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();
  const current = pairingAttempts.get(key);

  if (!current || now > current.resetAt) {
    pairingAttempts.set(key, { count: 1, resetAt: now + PAIRING_WINDOW_MS });
    return true;
  }

  if (current.count >= PAIRING_MAX_ATTEMPTS) {
    return false;
  }

  current.count += 1;
  return true;
}

// ---------------------------------------------------------------------------
// Identity bookkeeping for paired devices
// ---------------------------------------------------------------------------

const PAIRED_DEVICE_IDENTITY_DISPLAY_NAME = "paired-device";
const PAIRED_GUEST_IDENTITY_DISPLAY_NAME = "paired-guest-device";

type PairingAccess = "owner" | "guest";

/**
 * Resolve an identity id to bind a paired-device machine session to. Owner
 * pairing preserves OWNER authority; explicit guest pairing
 * always creates a distinct machine identity so devices can be independently
 * bound, revoked, and audited:
 *   1. existing owner identity (typical password-configured deployments).
 *   2. otherwise create an owner identity dedicated to the paired operator.
 *
 * The machine session itself is what authorizes requests; the identity is a
 * stable parent row so audit logs + the security UI can group sessions
 * minted by the pairing flow.
 */
async function ensurePairedDeviceIdentityId(
  store: import("../services/auth-store").AuthStore,
  access: PairingAccess,
): Promise<string> {
  if (access === "guest") {
    const id = crypto.randomUUID();
    await store.createIdentity({
      id,
      kind: "machine",
      displayName: PAIRED_GUEST_IDENTITY_DISPLAY_NAME,
      createdAt: Date.now(),
      passwordHash: null,
      cloudUserId: null,
    });
    return id;
  }

  const owner = (await store.listIdentitiesByKind("owner"))[0];
  if (owner) return owner.id;

  const id = crypto.randomUUID();
  await store.createIdentity({
    id,
    kind: "owner",
    displayName: PAIRED_DEVICE_IDENTITY_DISPLAY_NAME,
    createdAt: Date.now(),
    passwordHash: null,
    cloudUserId: null,
  });
  return id;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Auth / pairing routes:
 *
 * - `GET  /api/first-run/status`
 * - `GET  /api/auth/status`
 * - `GET  /api/auth/pair-code`
 * - `POST /api/auth/guest-pair-code`
 * - `POST /api/auth/pair`
 */
export async function handleAuthPairingCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── GET /api/first-run/status ──────────────────────────────────────
  // Requires a trusted local request, a valid cookie session, an allowed
  // bearer token, or a bootstrap exchange — no unauthenticated bypass.
  if (method === "GET" && url.pathname === "/api/first-run/status") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const config = loadElizaConfig();
    sendJsonResponse(res, 200, {
      complete: hasCompatPersistedFirstRunState(config),
      // Metadata only — no auth implication. The client uses this to decide
      // whether to show the bootstrap-token wizard step. Auth is enforced by
      // the exchange endpoint itself; this flag never grants access.
      cloudProvisioned: isCloudProvisioned(),
    });
    return true;
  }

  // ── GET /api/auth/status ────────────────────────────────────────────
  // This is a public probe so unauthenticated clients can decide whether
  // to show pairing UI. The response leaks no secrets — only whether auth
  // is configured and whether pairing is currently open.
  if (method === "GET" && url.pathname === "/api/auth/status") {
    const localAccess = isTrustedLocalRequest(req);
    const db = getCompatDrizzleDb(state);
    let passwordConfigured = false;
    let sessionAuthenticated = false;
    if (db) {
      const store = new AuthStore(
        db as ConstructorParameters<typeof AuthStore>[0],
      );
      const owner = (await store.listIdentitiesByKind("owner"))[0];
      passwordConfigured = Boolean(owner?.passwordHash);
      sessionAuthenticated = await requestHasActiveSession(req, store);
    }
    const cloudProvisioned = isCloudProvisioned();
    const tokenRequired = Boolean(getCompatApiToken());
    const loginRequired = !localAccess && !tokenRequired && !cloudProvisioned;
    // Did this request already authenticate? Surfaced as a separate
    // `authenticated` field so the client can short-circuit pairing without
    // overloading the existing `required` semantics.
    const providedToken = getProvidedApiToken(req);
    const configuredToken = getCompatApiToken();
    const staticTokenAuthenticated =
      !cloudProvisioned &&
      Boolean(
        providedToken &&
          configuredToken &&
          tokenMatches(configuredToken, providedToken),
      );
    const authenticated = sessionAuthenticated || staticTokenAuthenticated;
    const required =
      !localAccess &&
      !authenticated &&
      (tokenRequired ||
        passwordConfigured ||
        cloudProvisioned ||
        loginRequired);
    const enabled = pairingEnabled();
    if (enabled) {
      ensurePairingCode();
    }
    sendJsonResponse(res, 200, {
      required,
      authenticated,
      loginRequired,
      bootstrapRequired: required && cloudProvisioned,
      localAccess,
      passwordConfigured,
      pairingEnabled: enabled,
      expiresAt: enabled ? pairingExpiresAt : null,
      instanceId: pairingInstanceId,
    });
    return true;
  }

  // ── GET /api/auth/pair-code ─────────────────────────────────────────
  // Loopback-only helper for local dashboards/operators. External clients
  // must use the normal pairing flow and never receive the code directly.
  if (method === "GET" && url.pathname === "/api/auth/pair-code") {
    if (!isTrustedLocalRequest(req)) {
      sendJsonErrorResponse(res, 403, "Pair code visible on loopback only");
      return true;
    }
    const code = ensurePairingCode();
    if (!code) {
      sendPairingError(
        res,
        503,
        AUTH_PAIRING_ERROR_CODES.disabled,
        "Pairing not enabled",
      );
      return true;
    }
    sendJsonResponse(res, 200, {
      code,
      expiresAt: pairingExpiresAt,
      instanceId: pairingInstanceId,
    });
    return true;
  }

  // ── POST /api/auth/guest-pair-code ─────────────────────────────────
  // Guest authority is attached to a server-held one-time grant. The public
  // pair endpoint never accepts a caller-selected role, so possession of the
  // normal operator code cannot be downgraded or repurposed as a guest invite,
  // and a guest code cannot be elevated by changing the request body.
  if (method === "POST" && url.pathname === "/api/auth/guest-pair-code") {
    if (!pairingEnabled()) {
      sendPairingError(
        res,
        403,
        AUTH_PAIRING_ERROR_CODES.disabled,
        "Pairing disabled",
      );
      return true;
    }
    if (!(await ensureRouteMinRole(req, res, state, "OWNER"))) {
      return true;
    }
    sendJsonResponse(res, 201, {
      ...createGuestPairingInvite(),
      access: "guest",
    });
    return true;
  }

  // ── POST /api/auth/pair ─────────────────────────────────────────────
  if (method === "POST" && url.pathname === "/api/auth/pair") {
    const body = await readCompatJsonBody(req, res);
    if (body == null) {
      return true;
    }

    const token = getCompatApiToken();
    if (!token) {
      sendPairingError(
        res,
        400,
        AUTH_PAIRING_ERROR_CODES.disabled,
        "Pairing not enabled",
      );
      return true;
    }
    if (!pairingEnabled()) {
      sendPairingError(
        res,
        403,
        AUTH_PAIRING_ERROR_CODES.disabled,
        "Pairing disabled",
      );
      return true;
    }
    const remoteAddress = req.socket.remoteAddress;
    if (!remoteAddress) {
      sendPairingError(
        res,
        403,
        AUTH_PAIRING_ERROR_CODES.invalid,
        "Cannot determine client address",
      );
      return true;
    }

    const requestedInstanceId =
      typeof body.instanceId === "string" ? body.instanceId : "";
    if (
      !requestedInstanceId ||
      !tokenMatches(pairingInstanceId, requestedInstanceId)
    ) {
      sendPairingError(
        res,
        409,
        AUTH_PAIRING_ERROR_CODES.instanceMismatch,
        "Pairing target changed. Refresh pairing status and use the current code.",
      );
      return true;
    }

    const provided = normalizePairingCode(
      typeof body.code === "string" ? body.code : "",
    );
    const current = pairingCode ?? ensurePairingCode();
    const now = Date.now();
    const guestInviteDigest = pairingCodeDigest(provided);
    const guestInvite = guestPairingInvites.get(guestInviteDigest);
    if (guestInvite && now > guestInvite.expiresAt) {
      guestPairingInvites.delete(guestInviteDigest);
      sendPairingError(
        res,
        410,
        AUTH_PAIRING_ERROR_CODES.expired,
        "Guest pairing code expired. Ask the owner for a new invitation.",
      );
      return true;
    }
    if (
      current &&
      now > pairingExpiresAt &&
      tokenMatches(normalizePairingCode(current), provided)
    ) {
      pairingCode = null;
      pairingExpiresAt = 0;
      ensurePairingCode();
      sendPairingError(
        res,
        410,
        AUTH_PAIRING_ERROR_CODES.expired,
        "Pairing code expired. Check server logs for a new code.",
      );
      return true;
    }

    const pairingAccess: PairingAccess | null = guestInvite
      ? "guest"
      : current && tokenMatches(normalizePairingCode(current), provided)
        ? "owner"
        : null;
    if (!pairingAccess) {
      if (!rateLimitPairing(remoteAddress)) {
        sendPairingError(
          res,
          429,
          AUTH_PAIRING_ERROR_CODES.rateLimited,
          "Too many attempts. Try again later.",
        );
        return true;
      }
      sendPairingError(
        res,
        403,
        AUTH_PAIRING_ERROR_CODES.invalid,
        "Invalid pairing code",
      );
      return true;
    }

    // Mint a machine session so the paired client gets a session-id bearer
    // token that authenticates against `ensureCompatApiAuthorizedAsync`.
    // Sessions are TTL-bound and revocable; the raw static connection key is
    // forever-valid and non-revocable, so it must NEVER be returned here
    // (#13985): the compat routes mount before the runtime DB finishes booting,
    // and a device that paired during that window would keep a permanent
    // full-authority bearer. If the DB isn't ready yet, fail closed with a
    // retryable 503 and leave the pairing code intact — its TTL gives the
    // client headroom to retry once the runtime is up.
    const db = getCompatDrizzleDb(state);
    if (!db) {
      sendPairingError(
        res,
        503,
        AUTH_PAIRING_ERROR_CODES.notReady,
        "Pairing not ready yet, retry shortly",
      );
      return true;
    }

    // Consume the code only now that a session can actually be minted, so the
    // transient DB-not-ready 503 above does not burn a still-valid code.
    if (pairingAccess === "guest") {
      guestPairingInvites.delete(guestInviteDigest);
    } else {
      pairingCode = null;
      pairingExpiresAt = 0;
    }

    try {
      const store = new AuthStore(
        db as ConstructorParameters<typeof AuthStore>[0],
      );
      const identityId = await ensurePairedDeviceIdentityId(
        store,
        pairingAccess,
      );
      const { session } = await createMachineSession(store, {
        identityId,
        scopes: [],
        label: "paired-device",
        ip: remoteAddress,
      });
      sendJsonResponse(res, 200, {
        token: session.id,
        instanceId: pairingInstanceId,
        identityId,
        access: pairingAccess,
      });
      return true;
    } catch (err) {
      // Surface the failure rather than silently falling back to a path that
      // mints a forever-valid static-token bearer. Operators should see the
      // underlying error and fix it; clients retry pairing.
      logger.error(
        `[api] pair: failed to mint machine session: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      sendPairingError(
        res,
        500,
        AUTH_PAIRING_ERROR_CODES.sessionFailed,
        "Failed to mint session",
      );
      return true;
    }
  }

  return false;
}
