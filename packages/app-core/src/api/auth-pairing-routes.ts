import crypto from "node:crypto";
import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import { logger } from "@elizaos/core";
import {
  createMachineSession,
  findActiveSession,
  parseSessionCookie,
} from "./auth/sessions";
import {
  ensureRouteAuthorized,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "./auth.ts";
import {
  type CompatRuntimeState,
  getCompatDrizzleDb,
  hasCompatPersistedOnboardingState,
  isTrustedLocalRequest,
  readCompatJsonBody,
} from "./compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "./response";
import { isCloudProvisioned } from "./server-onboarding-helpers";

// ---------------------------------------------------------------------------
// Pairing state & helpers
// ---------------------------------------------------------------------------

const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let pairingCode: string | null = null;
let pairingExpiresAt = 0;
const pairingAttempts = new Map<string, { count: number; resetAt: number }>();

// Periodic sweep to prevent unbounded memory growth
const PAIRING_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const pairingSweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pairingAttempts) {
    if (now > entry.resetAt) {
      pairingAttempts.delete(key);
    }
  }
}, PAIRING_SWEEP_INTERVAL_MS);
if (typeof pairingSweepTimer === "object" && "unref" in pairingSweepTimer) {
  pairingSweepTimer.unref();
}

export function _resetAuthPairingStateForTests(): void {
  pairingCode = null;
  pairingExpiresAt = 0;
  pairingAttempts.clear();
}

function pairingEnabled(): boolean {
  return (
    Boolean(getCompatApiToken()) &&
    process.env.ELIZA_PAIRING_DISABLED !== "1" &&
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

function ensurePairingCode(): string | null {
  if (!pairingEnabled()) {
    return null;
  }

  const now = Date.now();
  if (!pairingCode || now > pairingExpiresAt) {
    pairingCode = generatePairingCode();
    pairingExpiresAt = now + PAIRING_TTL_MS;
    logger.warn(
      `[api] Pairing code for remote devices: ${pairingCode} (valid for 10 minutes)`,
    );
  }

  return pairingCode;
}

export function ensureAuthPairingCodeForRemoteAccess(): {
  code: string;
  expiresAt: number;
} | null {
  const code = ensurePairingCode();
  return code ? { code, expiresAt: pairingExpiresAt } : null;
}

async function requestHasActiveSession(
  req: http.IncomingMessage,
  store: import("../services/auth-store").AuthStore,
): Promise<boolean> {
  const cookieSessionId = parseSessionCookie(req);
  if (cookieSessionId) {
    const session = await findActiveSession(store, cookieSessionId).catch(
      () => null,
    );
    if (session) return true;
  }

  const bearer = getProvidedApiToken(req);
  if (bearer) {
    const session = await findActiveSession(store, bearer).catch(() => null);
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

/**
 * Resolve an identity id to bind a paired-device machine session to:
 *   1. existing owner identity (typical password-configured deployments).
 *   2. existing `paired-device` machine identity (idempotent on repeat pair).
 *   3. otherwise create a fresh `paired-device` machine identity.
 *
 * The machine session itself is what authorizes requests; the identity is a
 * stable parent row so audit logs + the security UI can group sessions
 * minted by the pairing flow.
 */
async function ensurePairedDeviceIdentityId(
  store: import("../services/auth-store").AuthStore,
): Promise<string> {
  const owner = (await store.listIdentitiesByKind("owner"))[0];
  if (owner) return owner.id;

  const existing = await store.findIdentityByDisplayName(
    PAIRED_DEVICE_IDENTITY_DISPLAY_NAME,
  );
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await store.createIdentity({
    id,
    kind: "machine",
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
 * - `GET  /api/onboarding/status`
 * - `GET  /api/auth/status`
 * - `GET  /api/auth/pair-code`
 * - `POST /api/auth/pair`
 */
export async function handleAuthPairingCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  // ── GET /api/onboarding/status ──────────────────────────────────────
  // Cloud-provisioned containers used to skip auth here entirely. That
  // bypass is gone: callers now need a trusted local request, a valid
  // cookie session, an allowed bearer token, or a bootstrap exchange.
  if (method === "GET" && url.pathname === "/api/onboarding/status") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const config = loadElizaConfig();
    sendJsonResponse(res, 200, {
      complete: hasCompatPersistedOnboardingState(config),
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
      const { AuthStore } = await import("../services/auth-store");
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
      sendJsonErrorResponse(res, 503, "Pairing not enabled");
      return true;
    }
    sendJsonResponse(res, 200, { code, expiresAt: pairingExpiresAt });
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
      sendJsonErrorResponse(res, 400, "Pairing not enabled");
      return true;
    }
    if (!pairingEnabled()) {
      sendJsonErrorResponse(res, 403, "Pairing disabled");
      return true;
    }
    const remoteAddress = req.socket.remoteAddress;
    if (!remoteAddress) {
      sendJsonErrorResponse(res, 403, "Cannot determine client address");
      return true;
    }
    if (!rateLimitPairing(remoteAddress)) {
      sendJsonErrorResponse(res, 429, "Too many attempts. Try again later.");
      return true;
    }

    const provided = normalizePairingCode(
      typeof body.code === "string" ? body.code : "",
    );
    const current = ensurePairingCode();
    if (!current || Date.now() > pairingExpiresAt) {
      ensurePairingCode();
      sendJsonErrorResponse(
        res,
        410,
        "Pairing code expired. Check server logs for a new code.",
      );
      return true;
    }

    if (!tokenMatches(normalizePairingCode(current), provided)) {
      sendJsonErrorResponse(res, 403, "Invalid pairing code");
      return true;
    }

    pairingCode = null;
    pairingExpiresAt = 0;

    // Mint a machine session so the paired client gets a session-id bearer
    // token that authenticates against `ensureCompatApiAuthorizedAsync`.
    // Returning the raw connection key here would auth `/api/auth/status`
    // (static-token branch) but get rejected on every other route once the
    // runtime DB is up. Sessions are TTL-bound and revocable; the static
    // connection key is forever-valid until the operator rotates it.
    const db = getCompatDrizzleDb(state);
    if (db) {
      try {
        const { AuthStore } = await import("../services/auth-store");
        const store = new AuthStore(
          db as ConstructorParameters<typeof AuthStore>[0],
        );
        const identityId = await ensurePairedDeviceIdentityId(store);
        const { session } = await createMachineSession(store, {
          identityId,
          scopes: [],
          label: "paired-device",
          ip: remoteAddress,
        });
        sendJsonResponse(res, 200, { token: session.id });
        return true;
      } catch (err) {
        // Surface the failure rather than silently falling back to a path
        // that mints a forever-valid static-token bearer. Operators should
        // see the underlying error and fix it; clients retry pairing.
        logger.error(
          `[api] pair: failed to mint machine session: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        sendJsonErrorResponse(res, 500, "Failed to mint session");
        return true;
      }
    }

    // No DB yet — extremely unlikely once the runtime is up enough to serve
    // requests, but preserve the legacy static-token return as a fallback.
    sendJsonResponse(res, 200, { token });
    return true;
  }

  return false;
}
