/**
 * Exercises the DEFAULT ticket store (not the in-memory test override) against a
 * mocked cache singleton, so the production atomicity gate at put() —
 * cache.supportsAtomicOperations() — is actually covered.
 *
 * RP finding #2 on #18331: the original replay-regression test replaced the
 * store with a custom in-memory implementation, so it never called
 * defaultTicketStore.put() or .take() and never exercised the
 * supportsAtomicOperations() gate. This file mocks the `cache` module directly
 * and restores the default store (no __setOAuthSuccessProofTicketStoreForTests)
 * to prove the real gate behaves correctly on both atomic and non-atomic
 * backends.
 *
 * Uses bun:test `mock.module` to replace ../../cache/client before the
 * success-proof module imports it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cache } from "../../cache/client";
import {
  consumeOAuthSuccessProof,
  mintOAuthSuccessProof,
  type OAuthSuccessProofTicket,
  type OAuthSuccessProofTicketStore,
} from "./success-proof";

const PREV = { ...process.env };

const BINDING = {
  organizationId: "org-1",
  userId: "user-1",
};

/**
 * Control knob for the mocked cache. Set supportsAtomic before minting a proof
 * so the test can assert the gate outcome. All fields default to "atomic + happy
 * path" so each test overrides only what it needs.
 */
interface MockCacheState {
  supportsAtomic: boolean;
  writeKind: "written" | "unavailable" | "error" | "invalid";
  /** Tickets stored by the (mocked) write path, keyed by nonce. */
  tickets: Map<string, OAuthSuccessProofTicket>;
}

const state: MockCacheState = {
  supportsAtomic: true,
  writeKind: "written",
  tickets: new Map(),
};

/**
 * The typed mock surface success-proof touches on the real cache singleton:
 * setWithOutcome (put), supportsAtomicOperations (gate), getAndDelete (take).
 */
/** Minimal structural shape of the cache methods the default store touches. */
interface CacheMethodShim {
  supportsAtomicOperations(): boolean;
  setWithOutcome<T>(
    key: string,
    value: T,
    ttlSeconds: number,
  ): Promise<{ kind: "written" | "unavailable" | "error" | "invalid"; backend: string }>;
  getAndDelete<T>(key: string): Promise<T | null>;
}

function buildMockCache(): CacheMethodShim {
  return {
    supportsAtomicOperations: () => state.supportsAtomic,
    setWithOutcome: async <T>(_key: string, value: T, _ttlSeconds: number) => {
      const ticket = value as unknown as OAuthSuccessProofTicket;
      // Only persist when the backend would actually acknowledge the write.
      if (state.writeKind === "written") {
        state.tickets.set(_key, ticket);
      }
      return { kind: state.writeKind, backend: "redis_native" };
    },
    getAndDelete: async <T>(key: string): Promise<T | null> => {
      const entry = state.tickets.get(key);
      if (!entry) return null;
      state.tickets.delete(key);
      return entry as unknown as T;
    },
  };
}

describe("oauth success proof — default store atomicity gate", () => {
  beforeEach(() => {
    process.env.OAUTH_SUCCESS_PROOF_SECRET = "test-oauth-success-proof-secret-32b";
    state.supportsAtomic = true;
    state.writeKind = "written";
    state.tickets.clear();
    // Point the real module-imported cache at our mock. The success-proof
    // module holds a live binding to the `cache` object imported at module
    // load; we replace its methods in place so the default store sees the mock.
    const mock = buildMockCache();
    (cache as unknown as Record<string, unknown>).supportsAtomicOperations =
      mock.supportsAtomicOperations;
    (cache as unknown as Record<string, unknown>).setWithOutcome = mock.setWithOutcome;
    (cache as unknown as Record<string, unknown>).getAndDelete = mock.getAndDelete;
  });

  afterEach(() => {
    process.env = { ...PREV };
  });

  it("does not mint a proof on a non-atomic backend (KV) — gate at put()", async () => {
    // RP #18331: supportsAtomicOperations() === false must cause put() to
    // return false, so mintOAuthSuccessProof fails closed and returns null.
    // The previous gate lived in take(); put() reported "written" and a
    // dead proof was minted.
    state.supportsAtomic = false;
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      connectionId: "conn-1",
      ...BINDING,
    });
    expect(proof).toBeNull();
    // No ticket was stored — the gate fired before setWithOutcome.
    expect(state.tickets.size).toBe(0);
  });

  it("mints and consumes a proof through the default store on an atomic backend", async () => {
    // The happy path: the default store (not the in-memory override) writes
    // via setWithOutcome and consumes via getAndDelete.
    const proof = await mintOAuthSuccessProof({
      platform: "twitter",
      ...BINDING,
    });
    expect(proof).toBeTruthy();
    // The default store persisted the ticket under the real key prefix.
    expect(state.tickets.size).toBe(1);
    const first = await consumeOAuthSuccessProof(proof, BINDING);
    expect(first.ok).toBe(true);
    // Second consume is already_used (getAndDelete consumed the ticket).
    const second = await consumeOAuthSuccessProof(proof, BINDING);
    expect(second).toEqual({ ok: false, reason: "already_used" });
  });

  it("does not mint a proof when setWithOutcome reports unavailable", async () => {
    // RP #18331 (carried from #18114): an unavailable backend must not be
    // indistinguishable from a successful write. The default store maps a
    // non-"written" outcome to false.
    state.writeKind = "unavailable";
    const proof = await mintOAuthSuccessProof({
      platform: "github",
      ...BINDING,
    });
    expect(proof).toBeNull();
    expect(state.tickets.size).toBe(0);
  });
});
