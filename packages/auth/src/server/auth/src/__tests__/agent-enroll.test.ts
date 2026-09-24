/**
 * Tests for keypair-only agent enrollment.
 *
 * Bidirectional proof: these exercise the enrollment challenge–response using the
 * SHIPPED P-256 verifier + ChallengeStore. The full happy path proves an agent
 * holding ONLY its keypair can self-authenticate; the deny paths prove every
 * failure fails closed (replay, expiry, wrong key, unknown agent, HMAC signer).
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_ENROLL_DOMAIN,
  type AgentSignerResolver,
  buildEnrollCanonicalString,
  issueEnrollChallenge,
  type ResolvedAgentSigner,
  verifyEnrollResponse,
} from "../agent-enroll";
import { generateP256KeyPair, signP256 } from "../authorization-keys";
import { ChallengeStore } from "../challenge-store";

function resolverFor(
  map: Record<string, ResolvedAgentSigner[]>,
): AgentSignerResolver {
  return async (agentId: string) => map[agentId] ?? [];
}

describe("agent enrollment (keypair-only self-auth)", () => {
  test("happy path: agent signs the challenge and enrolls", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-soliza";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: kp.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
      ],
    });

    const issued = await issueEnrollChallenge(store, agentId);
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("challenge not issued");

    // The canonical string is exactly what the server will recompute.
    expect(
      issued.challenge.canonicalString.startsWith(AGENT_ENROLL_DOMAIN),
    ).toBe(true);
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(verified).toEqual({ ok: true, agentId });
    store.destroy();
  });

  test("replay: the same nonce cannot be used twice", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-replay";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: kp.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
      ],
    });
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const first = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(first.ok).toBe(true);

    const second = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("replay should fail");
    expect(second.code).toBe("challenge_not_found");
    store.destroy();
  });

  test("expiry: a stale challenge is rejected", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-stale";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: kp.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
      ],
    });
    const t0 = 1_000_000;
    const issued = await issueEnrollChallenge(store, agentId, {
      now: t0,
      ttlMs: 1000,
    });
    if (!issued.ok) throw new Error("challenge not issued");
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
      now: t0 + 5000, // past ttl
      ttlMs: 1000,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("stale challenge should fail");
    expect(verified.code).toBe("challenge_expired");
    store.destroy();
  });

  test("wrong key: a signature from another keypair fails closed", async () => {
    const store = new ChallengeStore();
    const legit = await generateP256KeyPair();
    const attacker = await generateP256KeyPair();
    const agentId = "agent-wrongkey";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: legit.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
      ],
    });
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    const badSig = await signP256(
      attacker.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature: badSig,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("wrong key should fail");
    expect(verified.code).toBe("signature_invalid");
    store.destroy();
  });

  test("unknown agent / no active key fails closed", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-unknown";
    const resolve = resolverFor({}); // no signers registered
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("unknown agent should fail");
    expect(verified.code).toBe("no_active_key");
    store.destroy();
  });

  test("hmac signer cannot self-enroll (no asymmetric proof)", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-hmac";
    // Registered as hmac — must be ignored by the p256 filter.
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: kp.publicKeySpkiBase64,
          status: "active",
          keyType: "hmac",
        },
      ],
    });
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("hmac signer should not enroll");
    expect(verified.code).toBe("no_active_key");
    store.destroy();
  });

  test("revoked (inactive) key cannot enroll", async () => {
    const store = new ChallengeStore();
    const kp = await generateP256KeyPair();
    const agentId = "agent-revoked";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: kp.publicKeySpkiBase64,
          status: "revoked",
          keyType: "p256",
        },
      ],
    });
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    const signature = await signP256(
      kp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(verified.ok).toBe(false);
    if (verified.ok) throw new Error("revoked key should fail");
    expect(verified.code).toBe("no_active_key");
    store.destroy();
  });

  test("key rotation: verify tries each active key until one matches", async () => {
    const store = new ChallengeStore();
    const oldKp = await generateP256KeyPair();
    const newKp = await generateP256KeyPair();
    const agentId = "agent-rotate";
    const resolve = resolverFor({
      [agentId]: [
        {
          publicKey: oldKp.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
        {
          publicKey: newKp.publicKeySpkiBase64,
          status: "active",
          keyType: "p256",
        },
      ],
    });
    const issued = await issueEnrollChallenge(store, agentId);
    if (!issued.ok) throw new Error("challenge not issued");
    // Sign with the NEW (second) key — must still match.
    const signature = await signP256(
      newKp.privateKey,
      issued.challenge.canonicalString,
    );

    const verified = await verifyEnrollResponse(store, resolve, {
      agentId,
      nonce: issued.challenge.nonce,
      signature,
    });
    expect(verified.ok).toBe(true);
    store.destroy();
  });

  test("canonical string is domain-separated and order-fixed", () => {
    const s = buildEnrollCanonicalString({
      agentId: "a",
      nonce: "n",
      issuedAt: 42,
    });
    expect(s).toBe(`${AGENT_ENROLL_DOMAIN}\na\nn\n42`);
  });

  test("agentId is length- and charset-capped before it reaches the store (SEC-051)", async () => {
    const store = new ChallengeStore();
    const oversized = "a".repeat(200);
    const issued = await issueEnrollChallenge(store, oversized);
    expect(issued.ok).toBe(false);
    expect(store.size).toBe(0);

    for (const bad of ["agent id", "agent/id", "agent\nid", "é".repeat(10)]) {
      const res = await issueEnrollChallenge(store, bad);
      expect(res.ok).toBe(false);
    }
    expect(store.size).toBe(0);

    const verified = await verifyEnrollResponse(store, resolverFor({}), {
      agentId: oversized,
      nonce: "n",
      signature: "s",
    });
    expect(verified).toEqual({
      ok: false,
      error: "invalid agentId",
      code: "invalid_input",
    });
    store.destroy();
  });
});
