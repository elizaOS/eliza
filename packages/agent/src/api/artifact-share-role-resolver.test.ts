/**
 * Covers the artifact share-viewer token boundary: minting, verification, and
 * the read-only route allowlist.
 *
 * These tokens are disclosure capabilities handed to non-owner viewers, so the
 * security-relevant properties are the negative ones. A correctly-signed token
 * that claims an elevated role must still be rejected — the signature proves
 * provenance, not entitlement. Verification must never throw on hostile input,
 * because the resolver contract is `null` (no principal) rather than a 500. And
 * the route allowlist must stay read-only, so a leaked viewer token cannot
 * mutate anything or reach the wider API.
 *
 * Drives the real exported mint/verify path with a real HMAC secret.
 */
import crypto from "node:crypto";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isArtifactShareScopedRoute,
  issueArtifactShareViewerToken,
  resolveArtifactShareViewerToken,
} from "./artifact-share-role-resolver.ts";

const SECRET_ENV = "ELIZA_ARTIFACT_SHARE_TOKEN_SECRET";
const SECRET = "test-share-secret";
const ENTITY = "11111111-2222-4333-8444-555555555555" as UUID;
const NOW_MS = 1_800_000_000_000;

let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = previousSecret;
});

/** Mint with an arbitrary payload, correctly signed with the live secret. */
function signPayload(payload: unknown, secret = SECRET): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`esv1.${segment}`)
    .digest()
    .toString("base64url");
  return `esv1.${segment}.${signature}`;
}

describe("issueArtifactShareViewerToken", () => {
  it("mints a token that verifies back to the same identity", () => {
    const token = issueArtifactShareViewerToken(
      { entityId: ENTITY, role: "USER", ttlMs: 60_000 },
      NOW_MS,
    );
    const access = resolveArtifactShareViewerToken(
      token,
      Math.floor(NOW_MS / 1000),
    );
    expect(access).toEqual({
      entityId: ENTITY,
      role: "USER",
      exp: Math.floor((NOW_MS + 60_000) / 1000),
    });
  });

  it("fails fast rather than emitting a dead token when the secret is unset", () => {
    delete process.env[SECRET_ENV];
    expect(() =>
      issueArtifactShareViewerToken(
        { entityId: ENTITY, role: "USER", ttlMs: 60_000 },
        NOW_MS,
      ),
    ).toThrow();
  });

  it("rejects a non-UUID entity id", () => {
    expect(() =>
      issueArtifactShareViewerToken(
        { entityId: "not-a-uuid" as UUID, role: "GUEST", ttlMs: 60_000 },
        NOW_MS,
      ),
    ).toThrow();
  });
});

describe("resolveArtifactShareViewerToken", () => {
  const now = Math.floor(NOW_MS / 1000);
  const validToken = () =>
    issueArtifactShareViewerToken(
      { entityId: ENTITY, role: "USER", ttlMs: 60_000 },
      NOW_MS,
    );

  it("is inert when the secret is unset", () => {
    const token = validToken();
    delete process.env[SECRET_ENV];
    expect(resolveArtifactShareViewerToken(token, now)).toBeNull();
  });

  it("returns null for absent input", () => {
    expect(resolveArtifactShareViewerToken(null, now)).toBeNull();
    expect(resolveArtifactShareViewerToken(undefined, now)).toBeNull();
    expect(resolveArtifactShareViewerToken("", now)).toBeNull();
  });

  it("rejects a correctly-signed token claiming an elevated role", () => {
    // The signature proves provenance, not entitlement: OWNER/ADMIN must come
    // from the trunk boundary, never from a share-viewer capability.
    for (const role of ["OWNER", "ADMIN", "owner", "user", ""]) {
      const forged = signPayload({ entityId: ENTITY, role, exp: now + 60 });
      expect(resolveArtifactShareViewerToken(forged, now)).toBeNull();
    }
  });

  it("rejects a token signed with a different secret", () => {
    const foreign = signPayload(
      { entityId: ENTITY, role: "USER", exp: now + 60 },
      "some-other-secret",
    );
    expect(resolveArtifactShareViewerToken(foreign, now)).toBeNull();
  });

  it("rejects a tampered payload that keeps the original signature", () => {
    const token = validToken();
    const [prefix, , signature] = token.split(".");
    const swapped = Buffer.from(
      JSON.stringify({
        entityId: "99999999-2222-4333-8444-555555555555",
        role: "USER",
        exp: now + 60,
      }),
    ).toString("base64url");
    expect(
      resolveArtifactShareViewerToken(`${prefix}.${swapped}.${signature}`, now),
    ).toBeNull();
  });

  it("rejects an expired token, including one expiring exactly now", () => {
    const expired = signPayload({
      entityId: ENTITY,
      role: "USER",
      exp: now - 1,
    });
    const boundary = signPayload({ entityId: ENTITY, role: "USER", exp: now });
    expect(resolveArtifactShareViewerToken(expired, now)).toBeNull();
    expect(resolveArtifactShareViewerToken(boundary, now)).toBeNull();
  });

  it("rejects a non-numeric or missing expiry", () => {
    for (const exp of ["9999999999", null, undefined]) {
      const token = signPayload({ entityId: ENTITY, role: "USER", exp });
      expect(resolveArtifactShareViewerToken(token, now)).toBeNull();
    }
  });

  it("rejects a non-UUID entity id in an otherwise valid token", () => {
    const token = signPayload({
      entityId: "nope",
      role: "USER",
      exp: now + 60,
    });
    expect(resolveArtifactShareViewerToken(token, now)).toBeNull();
  });

  it("never throws on malformed token shapes", () => {
    for (const token of [
      "garbage",
      "esv1",
      "esv1.only-two",
      "esv1..sig",
      "esv1.payload.",
      "wrongprefix.a.b",
      "esv1.!!!not-base64!!!.@@@",
      `esv1.${"A".repeat(5_000)}.${"B".repeat(5_000)}`,
    ]) {
      expect(() => resolveArtifactShareViewerToken(token, now)).not.toThrow();
      expect(resolveArtifactShareViewerToken(token, now)).toBeNull();
    }
  });

  it("accepts a GUEST role token", () => {
    const token = issueArtifactShareViewerToken(
      { entityId: ENTITY, role: "GUEST", ttlMs: 60_000 },
      NOW_MS,
    );
    expect(resolveArtifactShareViewerToken(token, now)?.role).toBe("GUEST");
  });
});

describe("isArtifactShareScopedRoute", () => {
  it("allows exactly the read-only artifact routes", () => {
    for (const path of [
      "/api/transcripts",
      "/api/transcripts/abc",
      "/api/meetings",
      "/api/meetings/abc",
      "/api/files",
    ]) {
      expect(isArtifactShareScopedRoute("GET", path)).toBe(true);
    }
  });

  it("denies every non-GET method on an allowed path", () => {
    for (const method of [
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ]) {
      expect(isArtifactShareScopedRoute(method, "/api/transcripts")).toBe(
        false,
      );
    }
  });

  it("denies the wider API surface", () => {
    for (const path of [
      "/api/agents",
      "/api/messages",
      "/api/settings",
      "/api/transcripts/abc/extra",
      "/api/meetings/abc/notes",
      "/api/files/abc",
      "/api/transcriptsX",
      "/",
    ]) {
      expect(isArtifactShareScopedRoute("GET", path)).toBe(false);
    }
  });
});
