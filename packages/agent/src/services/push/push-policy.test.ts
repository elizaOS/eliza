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

  it("throws when the durable write is rejected (no fabricated success)", async () => {
    const rejecting = new PushPolicyStore({
      ...runtime,
      setCache: async () => false,
    });
    await expect(rejecting.save("owner-1", ALLOWED_POLICY)).rejects.toThrow(
      /rejected the push-policy write/,
    );
  });

  it("rejects with a typed ElizaError carrying the stable persist code", async () => {
    const rejecting = new PushPolicyStore({
      ...runtime,
      setCache: async () => false,
    });
    const rejection = rejecting.save("owner-1", ALLOWED_POLICY);
    await expect(rejection).rejects.toMatchObject({
      name: "ElizaError",
      code: PUSH_POLICY_PERSIST_FAILED_CODE,
    });
  });
});
