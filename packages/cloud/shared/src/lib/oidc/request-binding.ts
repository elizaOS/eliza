/**
 * Binding of a parked authorization request to the browser that started it.
 *
 * The parking lot exists because a signed-out `/authorize` cannot carry its
 * request through the SPA login page (`./codes.ts`), so the round trip carries
 * only an opaque `rid`. That id travels in a URL: through `returnTo`, the login
 * page's address bar, browser history, and any Referer or access log on the
 * way. A bearer id in a URL is not a browser identity, so `/resume` must prove
 * that the browser presenting it is the one the request was parked for.
 *
 * Two independent inputs, hashed together and stored as one digest:
 *
 * - A 256-bit secret returned to the browser in a host-scoped, `HttpOnly`,
 *   `SameSite=Lax` cookie named after the request. This is the load-bearing
 *   half — it is unguessable and it does not travel in the URL, so a leaked
 *   `rid` alone proves nothing. The cookie is per-request so two sign-ins
 *   started from one browser do not evict each other.
 * - The originating `User-Agent`, which costs nothing and catches a replay from
 *   a different client even in the case where the cookie was captured too.
 *
 * The client IP is deliberately NOT an input: mobile networks re-address a
 * browser mid-flow, and a NAT egress is shared by everyone behind it, so it
 * would both break real logins and admit the attacker most likely to have the
 * id.
 *
 * The accepted cost: finishing the login in a DIFFERENT browser from the one
 * that started it — a magic-link mail opened outside an in-app web view, say —
 * no longer resumes. That browser is signed in by then, so starting again from
 * the relying party completes without a bounce.
 *
 * Only the digest is stored. A database dump therefore yields nothing that can
 * be presented at `/resume`.
 */

import { timingSafeEqualSecret } from "../auth/cron";
import { createOpaqueHex, sha256Hex } from "./crypto";

/**
 * Cookie names are `<prefix>_<16 hex>` derived from the request id, so the
 * browser holds one cookie per pending authorization and `/resume` can find the
 * right one from the `rid` it was handed.
 */
const COOKIE_PREFIX = "eliza-oidc-bind";
const COOKIE_SUFFIX_LENGTH = 16;
const COOKIE_SUFFIX_RE = /^[0-9a-f]{16}$/;

export interface OidcRequestBinding {
  /** The per-request secret this browser was handed in its cookie. */
  secret: string;
  /** The browser's `User-Agent`, or null when it sent none. */
  userAgent: string | null;
}

/**
 * The cookie this request's binding secret lives in. Throws for an id that is
 * not in the opaque hex form, because a name derived from arbitrary text would
 * not be a valid cookie name.
 */
export function oidcRequestBindingCookieName(requestId: string): string {
  const suffix = requestId.slice(-COOKIE_SUFFIX_LENGTH);
  if (!COOKIE_SUFFIX_RE.test(suffix)) {
    throw new Error("OIDC request binding: request id is not an opaque hex id");
  }
  return `${COOKIE_PREFIX}_${suffix}`;
}

/** 256 bits of CSPRNG output; handed to the browser, never stored in the clear. */
export function createOidcRequestBindingSecret(): string {
  return createOpaqueHex();
}

/**
 * Digest stored beside the parked request. The newline separator cannot occur
 * in the hex secret, so no `(secret, userAgent)` pair can be reassembled into
 * another pair's digest.
 */
export function computeOidcRequestBindingHash(binding: OidcRequestBinding): Promise<string> {
  return sha256Hex(`${binding.secret}\n${binding.userAgent ?? ""}`);
}

/**
 * Whether this browser is the one the request was parked for.
 *
 * A missing cookie is a mismatch, never a skip: the binding would otherwise be
 * bypassable by simply not sending it.
 */
export async function matchesOidcRequestBinding(
  expectedHash: string,
  presented: OidcRequestBinding | null,
): Promise<boolean> {
  if (!presented || !presented.secret) return false;
  return timingSafeEqualSecret(await computeOidcRequestBindingHash(presented), expectedHash);
}
