/** Unit tests for OAuth success-proof mint/verify (HMAC gate). */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearOAuthSuccessParams,
  isOAuthSuccessConnectedParam,
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
  verifyOAuthSuccessProof,
} from "./success-proof";

const PREV = { ...process.env };

describe("oauth success proof", () => {
  beforeEach(() => {
    process.env.OAUTH_SUCCESS_PROOF_SECRET = "test-oauth-success-proof-secret-32b";
  });

  afterEach(() => {
    process.env = { ...PREV };
  });

  it("mints and verifies a platform + connection proof", () => {
    const proof = mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
    });
    expect(proof).toBeTruthy();
    const result = verifyOAuthSuccessProof(proof);
    expect(result).toEqual({
      ok: true,
      payload: expect.objectContaining({
        platform: "github",
        connectionId: "conn-1",
      }),
    });
  });

  it("mints twitter proofs without a connection id", () => {
    const proof = mintOAuthSuccessProof({ platform: "twitter" });
    expect(proof).toBeTruthy();
    const result = verifyOAuthSuccessProof(proof);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.platform).toBe("twitter");
      expect(result.payload.connectionId).toBeNull();
    }
  });

  it("rejects tampered signatures", () => {
    const proof = mintOAuthSuccessProof({
      platform: "google",
      connectionId: "c1",
    });
    expect(proof).toBeTruthy();
    const tampered = `${proof!.slice(0, -4)}aaaa`;
    expect(verifyOAuthSuccessProof(tampered)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects expired proofs", () => {
    const proof = mintOAuthSuccessProof({
      platform: "slack",
      connectionId: "c1",
      ttlMs: -1,
    });
    expect(verifyOAuthSuccessProof(proof)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects oversized proofs before HMAC work", () => {
    const huge = `${"a".repeat(3_000)}.${"b".repeat(64)}`;
    expect(verifyOAuthSuccessProof(huge)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("scopes connected-marker cleanup to known OAuth providers", () => {
    expect(isOAuthSuccessConnectedParam("github_connected")).toBe(true);
    expect(isOAuthSuccessConnectedParam("discord_connected")).toBe(true);
    expect(isOAuthSuccessConnectedParam("socket_connected")).toBe(false);
    expect(isOAuthSuccessConnectedParam("constructor_connected")).toBe(false);

    const url = new URL(
      "https://app.elizacloud.ai/auth/success?socket_connected=true&github_connected=true&proof=stale&keep=1&constructor_connected=1",
    );
    clearOAuthSuccessParams(url);
    expect(url.searchParams.get("socket_connected")).toBe("true");
    expect(url.searchParams.get("constructor_connected")).toBe("1");
    expect(url.searchParams.get("keep")).toBe("1");
    expect(url.searchParams.get("github_connected")).toBeNull();
    expect(url.searchParams.get("proof")).toBeNull();
  });

  it("identifies only the exact /auth/success path for proof attachment", () => {
    expect(isOAuthSuccessLandingPath("/auth/success")).toBe(true);
    expect(isOAuthSuccessLandingPath("/auth/success/")).toBe(true);
    expect(isOAuthSuccessLandingPath("/foo/auth/success")).toBe(false);
    expect(isOAuthSuccessLandingPath("/dashboard/settings")).toBe(false);
  });
});
