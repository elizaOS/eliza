/** Unit tests for OAuth success-proof mint/consume (HMAC + one-time ticket). */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setOAuthSuccessProofTicketStoreForTests,
  clearOAuthSuccessParams,
  consumeOAuthSuccessProof,
  createMemoryOAuthSuccessProofTicketStore,
  isOAuthSuccessConnectedParam,
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
  verifyOAuthSuccessProof,
} from "./success-proof";

const PREV = { ...process.env };

const BINDING = {
  organizationId: "org-1",
  userId: "user-1",
};

describe("oauth success proof", () => {
  beforeEach(() => {
    process.env.OAUTH_SUCCESS_PROOF_SECRET = "test-oauth-success-proof-secret-32b";
    __setOAuthSuccessProofTicketStoreForTests(createMemoryOAuthSuccessProofTicketStore());
  });

  afterEach(() => {
    __setOAuthSuccessProofTicketStoreForTests(null);
    process.env = { ...PREV };
  });

  it("mints and consumes a platform + connection proof once", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    const first = await consumeOAuthSuccessProof(proof, BINDING);
    expect(first).toEqual({
      ok: true,
      payload: expect.objectContaining({
        platform: "github",
        connectionId: "conn-1",
        organizationId: "org-1",
        userId: "user-1",
      }),
    });
    const second = await consumeOAuthSuccessProof(proof, BINDING);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("mints twitter proofs without a connection id and consumes once", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "twitter",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    const first = await consumeOAuthSuccessProof(proof, BINDING);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.payload.platform).toBe("twitter");
      expect(first.payload.connectionId).toBeNull();
    }
    const second = await consumeOAuthSuccessProof(proof, BINDING);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("rejects a forwarded proof bound to a different session", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "twitter",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    const result = await consumeOAuthSuccessProof(proof, {
      organizationId: "org-attacker",
      userId: "user-attacker",
    });
    expect(result).toEqual({ ok: false, reason: "binding_mismatch" });
    // Ticket must remain for the legitimate browser.
    const legitimate = await consumeOAuthSuccessProof(proof, BINDING);
    expect(legitimate.ok).toBe(true);
  });

  it("rejects tampered signatures", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "google",
      connectionId: "c1",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    const tampered = `${proof!.slice(0, -4)}aaaa`;
    expect(await consumeOAuthSuccessProof(tampered, BINDING)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects expired proofs", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "slack",
      connectionId: "c1",
      ttlMs: -1,
      ...BINDING,
    });
    expect(await consumeOAuthSuccessProof(proof, BINDING)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects oversized proofs before HMAC work", async () => {
    const huge = `${"a".repeat(3_000)}.${"b".repeat(64)}`;
    expect(await consumeOAuthSuccessProof(huge, BINDING)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("HMAC-only verify does not consume the ticket (codec check)", async () => {
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
      ...BINDING,
    });
    expect(verifyOAuthSuccessProof(proof).ok).toBe(true);
    expect(verifyOAuthSuccessProof(proof).ok).toBe(true);
    expect((await consumeOAuthSuccessProof(proof, BINDING)).ok).toBe(true);
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
