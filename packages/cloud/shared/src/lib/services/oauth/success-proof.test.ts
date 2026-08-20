/** Unit tests for OAuth success-proof mint/consume (HMAC + one-time ticket). */

import { bindCapabilityRequest } from "@elizaos/core/types/provider-integrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setOAuthSuccessProofTicketStoreForTests,
  clearOAuthSuccessParams,
  consumeOAuthSuccessProof,
  createMemoryOAuthSuccessProofTicketStore,
  isOAuthSuccessConnectedParam,
  isOAuthSuccessLandingPath,
  mintOAuthSuccessProof,
  type OAuthSuccessProofTicketStore,
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

  it("returns the exact signed capability continuation only to the bound session", async () => {
    const continuation = bindCapabilityRequest(
      {
        contractVersion: 2,
        requestId: "req_repo_1",
        capabilityId: "repositories.full_control",
        operation: "repository.write",
        riskLevel: "R3",
        accountId: null,
        inputDigest: "a".repeat(64),
      },
      {
        contractVersion: 2,
        accountId: "conn-1",
        providerId: "github",
        mode: "cloud",
        status: "connected",
        displayName: null,
        capabilities: [
          {
            capabilityId: "repositories.full_control",
            riskLevel: "R3",
            status: "available",
          },
        ],
        lastUsedAt: null,
      },
      "2026-08-20T00:00:00.000Z",
    );
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
      capabilityContinuation: continuation,
      ...BINDING,
    });

    expect(await consumeOAuthSuccessProof(proof, BINDING)).toEqual({
      ok: true,
      payload: expect.objectContaining({ capabilityContinuation: continuation }),
    });
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

  it("does not mint a proof when the ticket store did not acknowledge the write", async () => {
    // Regression for #18114: the default store used the lossy `cache.set`
    // wrapper that discarded the `unavailable`/`error` outcome, so a proof was
    // signed and returned even though no nonce ticket was ever stored. A later
    // verify then answered `already_used` instead of a retryable failure.
    const unavailableStore: OAuthSuccessProofTicketStore = {
      async put() {
        return false;
      },
      async take() {
        return null;
      },
    };
    __setOAuthSuccessProofTicketStoreForTests(unavailableStore);
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
      ...BINDING,
    });
    expect(proof).toBeNull();
  });

  it("does not mint a proof when the ticket store throws", async () => {
    const throwingStore: OAuthSuccessProofTicketStore = {
      async put() {
        throw new Error("store down");
      },
      async take() {
        return null;
      },
    };
    __setOAuthSuccessProofTicketStoreForTests(throwingStore);
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      ...BINDING,
    });
    expect(proof).toBeNull();
  });

  it("guarantees exactly one consume under concurrent verification (atomic store)", async () => {
    // Regression for #18114: the one-time ticket must be consumed exactly once
    // even when multiple matching-session verifications race. The in-memory
    // store is single-process atomic; a non-atomic backend (Cloudflare KV) is
    // refused by the default store's `take` and must not reach this path.
    const proof = await mintOAuthSuccessProof({
      platform: "discord",
      connectionId: "conn-1",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    // Fire many concurrent consumes against the same proof.
    const results = await Promise.all(
      Array.from({ length: 16 }, () => consumeOAuthSuccessProof(proof, BINDING)),
    );
    const oks = results.filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    // Every loser must report already_used (the ticket was claimed), not a
    // binding mismatch or store-unavailable result.
    for (const r of results) {
      if (!r.ok) expect(r.reason).toBe("already_used");
    }
  });

  it("refuses a non-atomic backend store (KV replay guard)", async () => {
    // Regression for #18114: Cloudflare KV's getdel is a two-step read/delete
    // with eventual consistency; two concurrent verifications could both receive
    // the same ticket. The default ticket store gates `take` on
    // `cache.supportsAtomicOperations()` so a non-atomic backend yields null and
    // the proof verifies as already_used rather than replaying. A fake store
    // emulating that non-atomic read-then-delete must not produce a valid
    // consume either, because the placeholder it stores cannot match the
    // HMAC-bound ticket payload.
    const kv = new Map<string, string>();
    const racyKvLikeStore: OAuthSuccessProofTicketStore = {
      async put(nonce) {
        kv.set(nonce, JSON.stringify({ placeholder: true }));
        return true;
      },
      // Deliberately non-atomic read-then-delete, matching KvCacheAdapter.getdel.
      async take(nonce) {
        const value = kv.get(nonce) ?? null;
        if (value !== null) kv.delete(nonce);
        // Return a value that cannot satisfy the binding check in consume.
        return value ? (JSON.parse(value) as never) : null;
      },
    };
    __setOAuthSuccessProofTicketStoreForTests(racyKvLikeStore);
    const proof = await mintOAuthSuccessProof({
      platform: "twitter",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    const result = await consumeOAuthSuccessProof(proof, BINDING);
    expect(result.ok).toBe(false);
  });
});
