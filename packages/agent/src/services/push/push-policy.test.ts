/**
 * Covers the per-principal inbox-before-push policy seam (#23106): the pure
 * fail-closed decision matrix (no recipient / no policy / corrupt policy /
 * denied / allowed), boundary validation of untrusted stored policy rows, and
 * the durable PushPolicyStore over a Map-backed cache. Harness is in-memory;
 * no real persistence or network.
 */

import type { AgentNotification } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  decidePushDelivery,
  PUSH_POLICY_CONFLICT_EXHAUSTED_CODE,
  PUSH_POLICY_PERSIST_FAILED_CODE,
  type PushDeliveryPolicy,
  PushPolicyStore,
  parsePushDeliveryPolicy,
} from "./push-policy.ts";

const ALLOWED_POLICY: PushDeliveryPolicy = {
  pushEnabled: true,
  version: 3,
  updatedAt: 1_700_000_000_000,
};
const DENIED_POLICY: PushDeliveryPolicy = {
  pushEnabled: false,
  version: 1,
  updatedAt: 1_700_000_000_000,
};

function notification(
  overrides: Partial<Pick<AgentNotification, "recipientId">> = {},
): Pick<AgentNotification, "recipientId"> {
  return { recipientId: "owner-1", ...overrides };
}

describe("decidePushDelivery (fail-closed matrix)", () => {
  it("denies with no_recipient when the notification carries no recipient", () => {
    const decision = decidePushDelivery(
      notification({ recipientId: undefined }),
      ALLOWED_POLICY,
    );
    expect(decision).toEqual({
      outcome: "deny",
      reason: "no_recipient",
      policyVersion: 0,
    });
  });

  it("denies with no_recipient for an empty-string recipient", () => {
    const decision = decidePushDelivery(
      notification({ recipientId: "" }),
      ALLOWED_POLICY,
    );
    expect(decision.outcome).toBe("deny");
    if (decision.outcome === "deny")
      expect(decision.reason).toBe("no_recipient");
  });

  it("denies with no_policy when the principal has no policy (never defaults to allow)", () => {
    const decision = decidePushDelivery(notification(), null);
    expect(decision).toEqual({
      outcome: "deny",
      reason: "no_policy",
      policyVersion: 0,
    });
  });

  it("denies with policy_denied when the policy explicitly disables push", () => {
    const decision = decidePushDelivery(notification(), DENIED_POLICY);
    expect(decision).toEqual({
      outcome: "deny",
      reason: "policy_denied",
      policyVersion: 1,
    });
  });

  it("allows only when the policy explicitly enables push, carrying the version", () => {
    const decision = decidePushDelivery(notification(), ALLOWED_POLICY);
    expect(decision).toEqual({ outcome: "allow", policyVersion: 3 });
  });
});

describe("parsePushDeliveryPolicy (untrusted boundary)", () => {
  it("accepts the exact canonical shape", () => {
    expect(parsePushDeliveryPolicy(ALLOWED_POLICY)).toEqual(ALLOWED_POLICY);
  });

  it("rejects every corrupt variant (fail-closed to null)", () => {
    const corrupt: unknown[] = [
      undefined,
      null,
      "pushEnabled",
      42,
      {},
      { ...ALLOWED_POLICY, pushEnabled: "true" },
      { ...ALLOWED_POLICY, version: "3" },
      { ...ALLOWED_POLICY, version: -1 },
      { ...ALLOWED_POLICY, version: 1.5 },
      { ...ALLOWED_POLICY, updatedAt: "yesterday" },
      { ...ALLOWED_POLICY, updatedAt: -1 },
      { pushEnabled: true }, // missing version + updatedAt
      { ...ALLOWED_POLICY, extra: true }, // extra key: not the canonical 3-key shape
      { pushEnabled: true, version: 1, updatedAt: 1, extra: "x" }, // 4-key variant
      // inherited-policy injection: three arbitrary own keys, valid values on
      // the prototype — passes a length-only check, blocked by key-set equality
      Object.assign(Object.create(ALLOWED_POLICY), { a: 1, b: 2, c: 3 }),
    ];
    for (const value of corrupt) {
      expect(parsePushDeliveryPolicy(value)).toBeNull();
    }
  });
});

describe("PushPolicyStore (durable per-principal store)", () => {
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "00000000-0000-0000-0000-0000000000aa",
    getCache: async <T>(key: string): Promise<T | undefined> =>
      cache.get(key) as T | undefined,
    setCache: async <T>(key: string, value: T): Promise<boolean> => {
      cache.set(key, value);
      return true;
    },
    compareAndSetCache: async <T>(
      key: string,
      expected: unknown,
      replacement: T,
    ): Promise<boolean> => {
      const stored = cache.get(key);
      const matches =
        expected === undefined
          ? stored === undefined
          : stored !== undefined &&
            JSON.stringify(stored) === JSON.stringify(expected);
      if (!matches) return false;
      cache.set(key, replacement);
      return true;
    },
  };
  let store: PushPolicyStore;

  beforeEach(() => {
    cache.clear();
    store = new PushPolicyStore(runtime);
  });

  it("returns null for an absent policy (the fail-closed default)", async () => {
    expect(await store.load("owner-1")).toBeNull();
  });

  it("round-trips a saved policy per principal (two principals stay isolated)", async () => {
    await store.save("owner-1", ALLOWED_POLICY);
    await store.save("owner-2", DENIED_POLICY);
    expect(await store.load("owner-1")).toEqual(ALLOWED_POLICY);
    expect(await store.load("owner-2")).toEqual(DENIED_POLICY);
    expect(await store.load("owner-3")).toBeNull();
  });

  it("treats a corrupt stored row as absent (fail-closed), not a throw", async () => {
    cache.set("push-policy:00000000-0000-0000-0000-0000000000aa:owner-1", {
      pushEnabled: true,
      version: "x",
    });
    await expect(store.load("owner-1")).resolves.toBeNull();
  });

  it("save() throws a typed error when the underlying CAS storage fails (no fabricated success)", async () => {
    const rejecting = new PushPolicyStore({
      ...runtime,
      compareAndSetCache: async () => {
        throw new Error("storage down");
      },
    });
    await expect(rejecting.save("owner-1", ALLOWED_POLICY)).rejects.toThrow(
      /failed to persist push-policy/,
    );
    await expect(
      rejecting.save("owner-1", ALLOWED_POLICY),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_POLICY_PERSIST_FAILED_CODE,
    });
  });

  it("save() rejects a non-monotonic version with the typed persist error (F4: no ABA, no regression to a stale record)", async () => {
    await store.save("owner-1", ALLOWED_POLICY);
    // A caller-supplied policy at or below the durable version must never
    // silently overwrite the fresher durable row.
    const stale = { ...ALLOWED_POLICY, version: 1 };
    await expect(store.save("owner-1", stale)).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_POLICY_PERSIST_FAILED_CODE,
      context: { reason: "version_not_monotonic" },
    });
    // The durable row is untouched.
    expect(await store.load("owner-1")).toEqual(ALLOWED_POLICY);
  });

  it("save() returns false-resolved CAS as a typed persist failure (conflict is not success)", async () => {
    const conflicting = new PushPolicyStore({
      ...runtime,
      // A CAS that always conflicts: someone else owns the row.
      compareAndSetCache: async () => false,
    });
    const conflict = conflicting.save("owner-1", ALLOWED_POLICY);
    await expect(conflict).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_POLICY_CONFLICT_EXHAUSTED_CODE,
    });
  });
});

describe("PushPolicyStore.update (serialized per-principal bump)", () => {
  const RUNTIME_AGENT_ID = "00000000-0000-0000-0000-0000000000aa";

  function makeStore(overrides?: {
    getCache?: <T>(key: string) => Promise<T | undefined>;
    setCache?: (key: string, value: unknown) => Promise<boolean>;
    compareAndSetCache?: (
      key: string,
      expected: unknown,
      replacement: unknown,
    ) => Promise<boolean>;
  }): {
    store: PushPolicyStore;
    cache: Map<string, unknown>;
  } {
    const cache = new Map<string, unknown>();
    const storeRuntime = {
      agentId: RUNTIME_AGENT_ID,
      getCache:
        overrides?.getCache ??
        (async <T>(key: string): Promise<T | undefined> =>
          cache.get(key) as T | undefined),
      setCache:
        overrides?.setCache ??
        (async (key: string, value: unknown): Promise<boolean> => {
          cache.set(key, value);
          return true;
        }),
      compareAndSetCache:
        overrides?.compareAndSetCache ??
        (async (
          key: string,
          expected: unknown,
          replacement: unknown,
        ): Promise<boolean> => {
          const stored = cache.get(key);
          const matches =
            expected === undefined
              ? stored === undefined
              : stored !== undefined &&
                JSON.stringify(stored) === JSON.stringify(expected);
          if (!matches) return false;
          cache.set(key, replacement);
          return true;
        }),
    };
    return { store: new PushPolicyStore(storeRuntime), cache };
  }

  it("bumps from absent to version 1 and applies the requested setting", async () => {
    const { store } = makeStore();
    const first = await store.update("owner-1", true);
    expect(first).toEqual({
      pushEnabled: true,
      version: 1,
      updatedAt: expect.any(Number),
    });
    const second = await store.update("owner-1", false);
    expect(second.pushEnabled).toBe(false);
    expect(second.version).toBe(2);
  });

  it("serializes concurrent same-principal updates: every PUT gets a distinct monotonic version (no lost update)", async () => {
    // Delay the FIRST cache read so both queued updates are in flight before
    // either critical section runs — without serialization both would compute
    // version 1 from the same absent row and one opt-out would be lost.
    let resolveFirstRead: (() => void) | undefined;
    const firstRead = new Promise<void>((resolve) => {
      resolveFirstRead = resolve;
    });
    let reads = 0;
    const { store, cache } = makeStore({
      getCache: async <T>(key: string): Promise<T | undefined> => {
        reads += 1;
        if (reads === 1) await firstRead;
        return cache.get(key) as T | undefined;
      },
    });

    const enable = store.update("owner-1", true);
    const disable = store.update("owner-1", false);
    // Both updates are now queued; release the first critical section.
    resolveFirstRead?.();

    const [enabledPolicy, disabledPolicy] = await Promise.all([
      enable,
      disable,
    ]);
    // Distinct monotonic versions prove serialization: the second update
    // re-loaded the first's durable row inside its own critical section.
    expect(enabledPolicy.version).toBe(1);
    expect(disabledPolicy.version).toBe(2);
    // Last-writer-wins by QUEUING ORDER (disable was queued second) — the
    // final durable row is the disable, with no overwritten opt-out.
    const final = await store.load("owner-1");
    expect(final).toEqual({
      pushEnabled: false,
      version: 2,
      updatedAt: disabledPolicy.updatedAt,
    });
  });

  it("does not let one principal's failed update poison another principal's queue", async () => {
    const { store } = makeStore({
      compareAndSetCache: async (
        _key: string,
        _expected: unknown,
        replacement: unknown,
      ): Promise<boolean> => {
        const policy = replacement as { pushEnabled: boolean };
        if (policy.pushEnabled === false) {
          throw new Error("storage rejects disable writes");
        }
        return true; // enables succeed without landing (not asserted below)
      },
    });
    await expect(store.update("owner-1", false)).rejects.toThrow(
      /failed to persist push-policy update/,
    );
    // The queue recovers: the SAME store's tail is not poisoned — a later
    // update for a different principal proceeds through its own tail.
    const ok = await store.update("owner-2", true);
    expect(ok.pushEnabled).toBe(true);
    expect(ok.version).toBe(1);
  });

  it("keeps the queue live after a failed same-principal update (no wedge)", async () => {
    let writes = 0;
    const sharedCache = new Map<string, unknown>();
    const { store } = makeStore({
      getCache: async <T>(key: string): Promise<T | undefined> =>
        sharedCache.get(key) as T | undefined,
      compareAndSetCache: async (
        key: string,
        expected: unknown,
        replacement: unknown,
      ): Promise<boolean> => {
        writes += 1;
        if (writes === 1) {
          throw new Error("first durable write fails");
        }
        const stored = sharedCache.get(key);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined &&
              JSON.stringify(stored) === JSON.stringify(expected);
        if (!matches) return false;
        sharedCache.set(key, replacement);
        return true;
      },
    });
    await expect(store.update("owner-1", true)).rejects.toThrow(
      /failed to persist push-policy update/,
    );
    const recovered = await store.update("owner-1", true);
    expect(recovered.version).toBe(1); // failed write never landed
    const next = await store.update("owner-1", false);
    expect(next.version).toBe(2);
  });

  it("serializes per principal: unrelated principals do not wait on each other", async () => {
    const cache = new Map<string, unknown>();
    let owner1Reads = 0;
    let releaseOwner1: (() => void) | undefined;
    const owner1Gate = new Promise<void>((resolve) => {
      releaseOwner1 = resolve;
    });
    const { store } = makeStore({
      getCache: async <T>(key: string): Promise<T | undefined> => {
        if (key.endsWith(":owner-1")) {
          owner1Reads += 1;
          if (owner1Reads === 1) await owner1Gate;
        }
        return cache.get(key) as T | undefined;
      },
      setCache: async (key: string, value: unknown): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
    });
    let blocked: Promise<PushDeliveryPolicy> | undefined;
    try {
      blocked = store.update("owner-1", true);
      const other = store.update("owner-2", true);
      // owner-2's update must complete WITHOUT waiting on owner-1's gate.
      const winner = await Promise.race([
        other.then(() => "owner-2" as const),
        new Promise<"owner-1">((resolve) =>
          setTimeout(() => resolve("owner-1"), 50),
        ),
      ]);
      expect(winner).toBe("owner-2");
    } finally {
      releaseOwner1?.();
      await blocked;
    }
  });

  it("drops a settled tail so the queue map tracks in-flight work only", async () => {
    const { store } = makeStore();
    await store.update("owner-1", true);
    await store.update("owner-1", false);
    // The settle-cleanup rides its own microtask chain after the caller's
    // await resolves; cross a macrotask boundary so it has certainly run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both updates settled and no later update chained: the tail entry is
    // removed, so the map cannot grow with every principal ever seen.
    expect(tailSizeFor(store)).toBe(0);
    // A fresh update re-seeds the tail and still serializes correctly.
    const third = await store.update("owner-1", true);
    expect(third.version).toBe(3);
  });

  it("keeps the newer tail when updates chain (identity-checked cleanup)", async () => {
    // Discriminating construction: the SECOND update's durable read is gated
    // AFTER the first update fully settles (so the first tail's cleanup has
    // run). If cleanup deleted the map entry unconditionally — instead of by
    // identity — the map would lose the second update's tail and the THIRD
    // update could enter its critical section before the second completes,
    // reading the same base row and duplicating its version.
    const cache = new Map<string, unknown>();
    let resolveSecondRead: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      resolveSecondRead = resolve;
    });
    // Resolves the moment the SECOND update enters its gated cache read. The
    // second update's critical section only starts after the first update's
    // recovered tail settles, and the first cleanup is registered on that
    // same promise BEFORE the second's continuation — so second-read-entry
    // guarantees the first cleanup has already run.
    let markSecondReadEntered: (() => void) | undefined;
    const secondReadEntered = new Promise<void>((resolve) => {
      markSecondReadEntered = resolve;
    });
    let owner1Loads = 0;
    const { store } = makeStore({
      getCache: async <T>(key: string): Promise<T | undefined> => {
        if (key.endsWith(":owner-1")) {
          owner1Loads += 1;
          if (owner1Loads === 2) {
            markSecondReadEntered?.();
            await secondGate; // gate the second update
          }
        }
        return cache.get(key) as T | undefined;
      },
      setCache: async (key: string, value: unknown): Promise<boolean> => {
        cache.set(key, value);
        return true;
      },
      // The durable CAS must read the SAME local cache the gated getCache
      // reads (update() persists through compareAndSetCache, not setCache).
      compareAndSetCache: async (
        key: string,
        expected: unknown,
        replacement: unknown,
      ): Promise<boolean> => {
        const stored = cache.get(key);
        const matches =
          expected === undefined
            ? stored === undefined
            : stored !== undefined &&
              JSON.stringify(stored) === JSON.stringify(expected);
        if (!matches) return false;
        cache.set(key, replacement);
        return true;
      },
    });

    const first = store.update("owner-1", true);
    const second = store.update("owner-1", false);
    const firstPolicy = await first; // first settles
    expect(firstPolicy.version).toBe(1);
    // Wait until the second update is INSIDE its gated read — by then the
    // first tail's cleanup has certainly run, so an unconditional delete
    // would already have emptied the map before we enqueue the third.
    await secondReadEntered;
    // The third update must chain BEHIND the gated second: with the identity
    // check the map still holds the second's tail; an unconditional cleanup
    // would have dropped it and the third would run CONCURRENTLY, reading the
    // same base row and duplicating a version.
    const third = store.update("owner-1", true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing else may have completed while the second update is gated.
    const inFlight = await Promise.race([
      Promise.race([second, third]).then(
        (policy) => `completed-early:v${policy.version}`,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still-queued"), 20),
      ),
    ]);
    expect(inFlight).toBe("still-queued");

    resolveSecondRead?.();
    const [secondPolicy, thirdPolicy] = await Promise.all([second, third]);
    // Distinct monotonic versions prove the chain held through cleanup.
    expect(secondPolicy.version).toBe(2);
    expect(thirdPolicy.version).toBe(3);
    const final = await store.load("owner-1");
    expect(final?.version).toBe(3);
    expect(final?.pushEnabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tailSizeFor(store)).toBe(0);
  });

  it("refuses to persist a version the fail-closed parser would reject (MAX_SAFE_INTEGER guard)", async () => {
    const cache = new Map<string, unknown>();
    cache.set("push-policy:00000000-0000-0000-0000-0000000000aa:owner-1", {
      pushEnabled: true,
      version: Number.MAX_SAFE_INTEGER,
      updatedAt: 1,
    });
    const { store } = makeStore({
      getCache: async <T>(key: string): Promise<T | undefined> =>
        cache.get(key) as T | undefined,
    });
    // The guarded bump refuses instead of writing MAX_SAFE_INTEGER + 1 (a
    // value the boundary parser fails closed on, degrading the principal to
    // policy_corrupt on every later load).
    await expect(store.update("owner-1", false)).rejects.toMatchObject({
      code: PUSH_POLICY_PERSIST_FAILED_CODE,
    });
    // The existing row is untouched.
    const row = await store.load("owner-1");
    expect(row?.version).toBe(Number.MAX_SAFE_INTEGER);
  });
});

/** Test-only view of the store's pending-tail count (bounded-memory contract). */
function tailSizeFor(store: PushPolicyStore): number {
  const tails = (
    store as unknown as {
      updateTails: Map<string, Promise<void>>;
    }
  ).updateTails;
  return tails.size;
}
