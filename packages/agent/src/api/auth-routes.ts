import crypto from "node:crypto";
import type { RouteRequestContext } from "./route-helpers";

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

  if (method === "GET" && pathname === "/api/auth/status") {
    const required = Boolean(process.env.ELIZA_API_TOKEN?.trim());
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
    const body = await readJsonBody<{ code?: string }>(req, res);
    if (!body) return true;

    const token = process.env.ELIZA_API_TOKEN?.trim();
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

    const provided = normalizePairingCode(body.code ?? "");
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
    json(res, { token });
    return true;
  }

  return false;
}
