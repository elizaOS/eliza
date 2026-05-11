import crypto from "node:crypto";
import { isCloudProvisionedContainer } from "@elizaos/plugin-elizacloud";
import type {
  PostAuthPairResponse,
  RouteRequestContext,
} from "@elizaos/shared";
import { PostAuthPairRequestSchema, resolveApiToken } from "@elizaos/shared";
import { isAuthorized, isTrustedLocalRequest } from "./server-helpers-auth.ts";

function getConfiguredApiToken(): string | undefined {
  return resolveApiToken(process.env) ?? undefined;
}

export interface AuthRouteContext extends RouteRequestContext {
  pairingEnabled: () => boolean;
  ensurePairingCode: () => string | null;
  normalizePairingCode: (code: string) => string;
  rateLimitPairing: (ip: string | null) => boolean;
  getPairingExpiresAt: () => number;
  clearPairing: () => void;
}

export async function handleAuthRoutes(
  ctx: AuthRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    readJsonBody,
    json,
    error,
    pairingEnabled,
    ensurePairingCode,
    normalizePairingCode,
    rateLimitPairing,
    getPairingExpiresAt,
    clearPairing,
  } = ctx;

  if (!pathname.startsWith("/api/auth/")) return false;

  if (method === "GET" && pathname === "/api/auth/me") {
    const authorized = isAuthorized(req);
    const localAccess =
      process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1" ||
      isTrustedLocalRequest(req);
    if (!authorized) {
      json(
        res,
        {
          reason: getConfiguredApiToken()
            ? "remote_auth_required"
            : "remote_password_not_configured",
          access: {
            mode: localAccess ? "local" : "remote",
            passwordConfigured: Boolean(getConfiguredApiToken()),
            ownerConfigured: false,
          },
        },
        401,
      );
      return true;
    }

    json(res, {
      identity: {
        id: localAccess ? "local-agent" : "bearer-agent",
        displayName: localAccess ? "Local Agent" : "API User",
        kind: "machine",
      },
      session: {
        id: localAccess ? "local" : "bearer",
        kind: localAccess ? "local" : "machine",
        expiresAt: null,
      },
      access: {
        mode: localAccess ? "local" : "bearer",
        passwordConfigured: !localAccess && Boolean(getConfiguredApiToken()),
        ownerConfigured: false,
      },
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/auth/status") {
    if (isCloudProvisionedContainer()) {
      // Steward-managed cloud containers enforce API auth upstream, but the
      // local pairing flow is intentionally unavailable there. Reporting
      // required=true would strand app-core clients in PairingView.
      json(res, {
        required: false,
        pairingEnabled: false,
        expiresAt: null,
      });
      return true;
    }
    const required = Boolean(getConfiguredApiToken());
    const enabled = pairingEnabled();
    if (enabled) ensurePairingCode();
    json(res, {
      required,
      pairingEnabled: enabled,
      expiresAt: enabled ? getPairingExpiresAt() : null,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/auth/pair") {
    // NOTE: this handler is shadowed by `handleAuthPairingCompatRoutes` in
    // `@elizaos/app-core` (the compat route mints a real machine session
    // bound to an identity, which authenticates against
    // `ensureCompatApiAuthorizedAsync`). This agent-only path is kept for
    // standalone agent-server usage; it returns the static connection key,
    // which only authenticates routes that explicitly accept the static
    // token (e.g. `/api/auth/status`). For full route coverage, run via
    // app-core so the compat handler intercepts first.
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null) return true;
    const parsed = PostAuthPairRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const issuePath = issue?.path?.join(".") ?? "<root>";
      error(
        res,
        `Invalid request body at ${issuePath}: ${issue?.message ?? "validation failed"}`,
        400,
      );
      return true;
    }

    if (isCloudProvisionedContainer()) {
      error(res, "Pairing disabled", 403);
      return true;
    }

    const token = getConfiguredApiToken();
    if (!token) {
      error(res, "Pairing not enabled", 400);
      return true;
    }
    if (!pairingEnabled()) {
      error(res, "Pairing disabled", 403);
      return true;
    }
    if (!rateLimitPairing(req.socket.remoteAddress ?? null)) {
      error(res, "Too many attempts. Try again later.", 429);
      return true;
    }

    const provided = normalizePairingCode(parsed.data.code);
    const current = ensurePairingCode();
    if (!current || Date.now() > getPairingExpiresAt()) {
      ensurePairingCode();
      error(
        res,
        "Pairing code expired. Check server logs for a new code.",
        410,
      );
      return true;
    }

    const expected = normalizePairingCode(current);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      error(res, "Invalid pairing code", 403);
      return true;
    }

    clearPairing();
    const response: PostAuthPairResponse = { token };
    json(res, response);
    return true;
  }

  return false;
}
