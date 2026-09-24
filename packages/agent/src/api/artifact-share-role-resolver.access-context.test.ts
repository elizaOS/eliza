/**
 * Contract for the artifact share-viewer boundary-role resolver (#14781):
 * registry integration and HTTP access context using real token minting and
 * verification. Only the http.IncomingMessage is a plain header carrier.
 */
import type http from "node:http";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ARTIFACT_SHARE_RESOLVER_ID,
  artifactShareRoleResolver,
  issueArtifactShareViewerToken,
  registerArtifactShareRoleResolver,
} from "./artifact-share-role-resolver.ts";
import {
  hasTokenRoleResolver,
  resolveRegisteredTokenRoleAccess,
} from "./boundary-role-resolver.ts";
import { resolveHttpAccessContext } from "./http-access-context.ts";

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
