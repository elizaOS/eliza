/**
 * App-side session tokens for the edad reference app.
 *
 * Eliza Cloud's app OAuth flow returns a SINGLE-USE authorization code
 * (`eac_…`) on the redirect, not a durable bearer. That code is redeemed ONCE,
 * server-side, at `GET /api/v1/app-auth/session` (which consumes it and returns
 * the signed-in user's identity). To keep the user signed in across requests
 * without re-redeeming a spent code, the app mints its OWN short-lived session
 * token here, signed with a server secret, and the browser presents it on each
 * call. This token authenticates the user TO THIS APP; upstream inference is
 * billed with the app owner's Cloud key + `x-app-id` (the app-credit-pool
 * monetization path), never with this token.
 *
 * Format: `<base64url(JSON{uid,exp})>.<base64url(HMAC_SHA256(payload))>`.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

export function mintAppSession(
  userId: string,
  secret: string,
  ttlMs: number = DEFAULT_TTL_MS,
  nowMs: number = Date.now(),
): string {
  if (!secret) throw new Error("app session secret is required");
  const payload = b64url(JSON.stringify({ uid: userId, exp: nowMs + ttlMs }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a session token and return its userId, or null if it is malformed, has
 * a bad signature, or is expired. Constant-time signature compare.
 */
export function verifyAppSession(
  token: string | null | undefined,
  secret: string,
  nowMs: number = Date.now(),
): string | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(payload, secret);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as { uid?: unknown; exp?: unknown };
    if (typeof decoded.uid !== "string" || typeof decoded.exp !== "number") {
      return null;
    }
    if (decoded.exp <= nowMs) return null;
    return decoded.uid;
  } catch {
    return null;
  }
}
