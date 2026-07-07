/**
 * Contract for the artifact share-viewer boundary-role resolver (#14781):
 * mint/verify round-trip over the real HMAC, tamper/expiry/secret gating, the
 * GET-only artifact route allowlist, and registry integration through the
 * trunk seam. Real crypto, real registry — only the http.IncomingMessage is a
 * plain header carrier.
 */
import type http from "node:http";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_SHARE_RESOLVER_ID,
  artifactShareRoleResolver,
  isArtifactShareScopedRoute,
  issueArtifactShareViewerToken,
  registerArtifactShareRoleResolver,
  resolveArtifactShareViewerToken,
} from "../../src/api/artifact-share-role-resolver.ts";
import {
  hasTokenRoleResolver,
  resolveRegisteredTokenRoleAccess,
} from "../../src/api/boundary-role-resolver.ts";
import { resolveHttpAccessContext } from "../../src/api/http-access-context.ts";

const VIEWER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const SECRET = "test-share-secret";

function reqWithToken(token?: string): http.IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as http.IncomingMessage;
}

beforeEach(() => {
  process.env.ELIZA_ARTIFACT_SHARE_TOKEN_SECRET = SECRET;
  registerArtifactShareRoleResolver();
});

afterEach(() => {
  delete process.env.ELIZA_ARTIFACT_SHARE_TOKEN_SECRET;
});

describe("share-viewer token mint/verify", () => {
  it("round-trips a USER token", () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    const access = resolveArtifactShareViewerToken(token);
    expect(access).toMatchObject({ entityId: VIEWER, role: "USER" });
  });

  it("rejects expiry, tamper, wrong prefix, and garbage", () => {
    const token = issueArtifactShareViewerToken(
      { entityId: VIEWER, role: "USER", ttlMs: 1_000 },
      0,
    );
    // Expired (minted at t=0 with 1s ttl, verified at t=10s).
    expect(resolveArtifactShareViewerToken(token, 10)).toBeNull();

    const live = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    // Signature tamper.
    expect(resolveArtifactShareViewerToken(`${live}x`)).toBeNull();
    // Payload tamper (role escalation attempt re-signs nothing).
    const [prefix, payload, sig] = live.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        entityId: VIEWER,
        role: "OWNER",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    expect(
      resolveArtifactShareViewerToken(`${prefix}.${forged}.${sig}`),
    ).toBeNull();
    expect(resolveArtifactShareViewerToken("esv1.garbage")).toBeNull();
    expect(resolveArtifactShareViewerToken("not-a-token")).toBeNull();
    expect(resolveArtifactShareViewerToken(undefined)).toBeNull();
    void payload;
  });

  it("is inert without the secret: no verify, and minting fails fast", () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    delete process.env.ELIZA_ARTIFACT_SHARE_TOKEN_SECRET;
    expect(resolveArtifactShareViewerToken(token)).toBeNull();
    expect(() =>
      issueArtifactShareViewerToken({
        entityId: VIEWER,
        role: "USER",
        ttlMs: 60_000,
      }),
    ).toThrow(/not configured/);
  });

  it("only ever mints USER/GUEST — a token can never carry an elevated tier", () => {
    // The role type is closed at compile time; at runtime a forged elevated
    // payload fails the role check in resolve (covered above). Verify GUEST
    // round-trips as the only other tier.
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "GUEST",
      ttlMs: 60_000,
    });
    expect(resolveArtifactShareViewerToken(token)?.role).toBe("GUEST");
  });
});

describe("route allowlist", () => {
  it("allows only the GET artifact read routes", () => {
    expect(isArtifactShareScopedRoute("GET", "/api/transcripts")).toBe(true);
    expect(isArtifactShareScopedRoute("GET", "/api/transcripts/abc")).toBe(
      true,
    );
    expect(isArtifactShareScopedRoute("GET", "/api/meetings")).toBe(true);
    expect(isArtifactShareScopedRoute("GET", "/api/meetings/abc")).toBe(true);
    expect(isArtifactShareScopedRoute("GET", "/api/files")).toBe(true);

    expect(isArtifactShareScopedRoute("DELETE", "/api/transcripts/abc")).toBe(
      false,
    );
    expect(isArtifactShareScopedRoute("POST", "/api/transcripts")).toBe(false);
    expect(isArtifactShareScopedRoute("PUT", "/api/transcripts/abc")).toBe(
      false,
    );
    expect(isArtifactShareScopedRoute("DELETE", "/api/files/x.png")).toBe(
      false,
    );
    expect(isArtifactShareScopedRoute("GET", "/api/conversations")).toBe(false);
    expect(isArtifactShareScopedRoute("GET", "/api/agents")).toBe(false);
  });
});

describe("trunk registry integration", () => {
  it("registers under its id and resolves canonical boundary access", () => {
    expect(hasTokenRoleResolver(ARTIFACT_SHARE_RESOLVER_ID)).toBe(true);
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    const access = resolveRegisteredTokenRoleAccess(reqWithToken(token));
    expect(access).toMatchObject({
      providerId: ARTIFACT_SHARE_RESOLVER_ID,
      worldRole: "USER",
      principal: VIEWER,
      isAdmin: false,
    });
    expect(
      artifactShareRoleResolver.resolve(reqWithToken("esv1.bad.token")),
    ).toBeNull();
  });

  it("maps onto an AccessContext with the token's entity as requester", () => {
    const token = issueArtifactShareViewerToken({
      entityId: VIEWER,
      role: "USER",
      ttlMs: 60_000,
    });
    expect(resolveHttpAccessContext(reqWithToken(token))).toEqual({
      requesterEntityId: VIEWER,
      role: "USER",
      isOwner: false,
      source: ARTIFACT_SHARE_RESOLVER_ID,
    });
    // No token → no principal (single-owner boundary).
    expect(resolveHttpAccessContext(reqWithToken())).toBeUndefined();
  });
});
