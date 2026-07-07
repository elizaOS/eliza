/**
 * Boundary-role resolver for artifact share-viewer tokens (#14781) — the HTTP
 * principal seam that lets a non-owner viewer reach the artifact read routes
 * (transcripts / meetings / files) with a per-entity identity, so the
 * use-case layer can select full vs redacted vs omitted DTO content per
 * viewer. Follows the WaifuChat resolver precedent: this module owns its token
 * vocabulary end to end and registers through the trunk's
 * {@link TokenRoleResolver} seam; the trunk auth path holds no share-token
 * literals.
 *
 * Token format: `esv1.<base64url payload>.<base64url HMAC-SHA256 signature>`
 * with payload `{ entityId, role: "USER" | "GUEST", exp }` (exp in epoch
 * seconds), keyed by `ELIZA_ARTIFACT_SHARE_TOKEN_SECRET`. The resolver is
 * inert when the secret is unset — local single-owner installs keep exactly
 * one boundary (the trunk API token). Minting lives here too
 * ({@link issueArtifactShareViewerToken}) so tests and the future sharing UX
 * (#14782) issue tokens through one code path; there is deliberately no
 * mint ROUTE in this change — grant-management UX is out of scope for #14781.
 *
 * Viewer tokens are read-only capabilities: `isRouteInScope` allows only the
 * GET artifact routes, so a leaked viewer token can never mutate or reach the
 * broader API surface. Byte serving is untouched — `/api/media/<sha256>` stays
 * pre-auth per the #8876 doctrine (the hash is the capability); these tokens
 * gate DISCLOSURE of references, not bytes.
 */
import crypto from "node:crypto";
import type http from "node:http";
import { ElizaError, type UUID, validateUuid } from "@elizaos/core";
import {
  type BoundaryRoleAccess,
  registerTokenRoleResolver,
  type TokenRoleResolver,
} from "./boundary-role-resolver.ts";
import { extractAuthToken } from "./server-helpers-auth.ts";

/** The artifact share resolver's stable registry id. */
export const ARTIFACT_SHARE_RESOLVER_ID = "artifact-share-viewer";

const TOKEN_PREFIX = "esv1";
const SECRET_ENV = "ELIZA_ARTIFACT_SHARE_TOKEN_SECRET";

/** Roles a share-viewer token may carry — never OWNER/ADMIN; elevated tiers use the trunk boundary. */
export type ArtifactShareViewerRole = "USER" | "GUEST";

/** Validated identity carried by one share-viewer token. */
export interface ArtifactShareViewerAccess {
  entityId: UUID;
  role: ArtifactShareViewerRole;
  /** Expiry, epoch seconds. */
  exp: number;
}

function shareSecret(): string | undefined {
  const secret = process.env[SECRET_ENV]?.trim();
  return secret && secret.length > 0 ? secret : undefined;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(payloadSegment: string, secret: string): Buffer {
  return crypto
    .createHmac("sha256", secret)
    .update(`${TOKEN_PREFIX}.${payloadSegment}`)
    .digest();
}

/**
 * Mint a share-viewer token for one entity. Server-side only (tests, and the
 * PERM-UX sharing journey once it lands). Throws when the signing secret is
 * not configured — minting must fail fast rather than emit dead tokens.
 */
export function issueArtifactShareViewerToken(
  input: {
    entityId: UUID;
    role: ArtifactShareViewerRole;
    ttlMs: number;
  },
  nowMs = Date.now(),
): string {
  const secret = shareSecret();
  if (!secret) {
    throw new ElizaError(
      `${SECRET_ENV} is not configured; cannot mint share-viewer tokens`,
      { code: "ARTIFACT_SHARE_SECRET_UNSET" },
    );
  }
  if (!validateUuid(input.entityId)) {
    throw new ElizaError("share-viewer token entityId must be a UUID", {
      code: "ARTIFACT_SHARE_INVALID_ENTITY",
      context: { entityId: input.entityId },
    });
  }
  const payload = {
    entityId: input.entityId,
    role: input.role,
    exp: Math.floor((nowMs + input.ttlMs) / 1000),
  };
  const payloadSegment = b64url(JSON.stringify(payload));
  const signature = b64url(hmac(payloadSegment, secret));
  return `${TOKEN_PREFIX}.${payloadSegment}.${signature}`;
}

/**
 * Parse + validate a share-viewer token: `null` when the secret is unset or
 * the token is absent, malformed, mis-signed, expired, or carries an invalid
 * entity/role. Never throws (resolver contract).
 */
export function resolveArtifactShareViewerToken(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): ArtifactShareViewerAccess | null {
  const secret = shareSecret();
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, payloadSegment, signatureSegment] = parts;
  if (!payloadSegment || !signatureSegment) return null;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureSegment, "base64url");
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an undecodable signature
    // segment is an invalid token, resolved to null (no principal).
    return null;
  }
  const expected = hmac(payloadSegment, secret);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(signature, expected)
  ) {
    return null;
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payloadSegment, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    payload = parsed as Record<string, unknown>;
  } catch {
    // error-policy:J3 untrusted-input sanitizing — an unparseable payload is an
    // invalid token, resolved to null (no principal), never a default identity.
    return null;
  }

  const entityId =
    typeof payload.entityId === "string"
      ? validateUuid(payload.entityId)
      : null;
  if (!entityId) return null;
  const role = payload.role;
  if (role !== "USER" && role !== "GUEST") return null;
  if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
    return null;
  }
  return { entityId, role, exp: payload.exp };
}

/**
 * Read-only artifact route allowlist for share-viewer principals. A viewer
 * token is a disclosure capability, not an account: no mutations, no chat, no
 * admin surface.
 */
export function isArtifactShareScopedRoute(
  method: string,
  pathname: string,
): boolean {
  if (method !== "GET") return false;
  if (pathname === "/api/transcripts") return true;
  if (/^\/api\/transcripts\/[^/]+$/.test(pathname)) return true;
  if (pathname === "/api/meetings") return true;
  if (/^\/api\/meetings\/[^/]+$/.test(pathname)) return true;
  if (pathname === "/api/files") return true;
  return false;
}

function toBoundaryAccess(
  access: ArtifactShareViewerAccess,
): BoundaryRoleAccess {
  return {
    providerId: ARTIFACT_SHARE_RESOLVER_ID,
    worldRole: access.role,
    principal: access.entityId,
    isAdmin: false,
    isRouteInScope: isArtifactShareScopedRoute,
    claims: { entityId: access.entityId, role: access.role, exp: access.exp },
  };
}

/** The artifact share-viewer boundary-role resolver. */
export const artifactShareRoleResolver: TokenRoleResolver = {
  id: ARTIFACT_SHARE_RESOLVER_ID,
  resolve(req: http.IncomingMessage): BoundaryRoleAccess | null {
    const access = resolveArtifactShareViewerToken(extractAuthToken(req));
    return access ? toBoundaryAccess(access) : null;
  },
};

let unregister: (() => void) | null = null;

/**
 * Register the artifact share-viewer resolver with the trunk boundary-role
 * registry. Idempotent — safe from module load and server setup.
 */
export function registerArtifactShareRoleResolver(): () => void {
  if (!unregister) {
    unregister = registerTokenRoleResolver(artifactShareRoleResolver);
  }
  return () => {
    unregister?.();
    unregister = null;
  };
}

// Self-register on import (mirrors the WaifuChat resolver): any code path that
// touches the share scheme activates it without the trunk knowing it exists.
registerArtifactShareRoleResolver();
