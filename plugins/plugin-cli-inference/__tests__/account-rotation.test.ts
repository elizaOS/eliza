import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSubscriptionLimitError,
  type RotationAccountSelection,
  rotationAgentTypeForBackend,
  rotationEnabled,
  withAccountRotation,
} from "../src/account-rotation";
import { ProviderApiError } from "../src/provider-errors";

/**
 * Issue #11180 Gap A: the chat brain must rotate to the next healthy pooled
 * account on a subscription limit, and ONLY on a subscription limit — a non-limit
 * error must fall straight through to the caller's provider-failover chain.
 *
 * These drive the pure rotation logic with a FAKE coding-agent selector bridge
 * installed on the `globalThis` symbol (the real bridge lives in app-core; the
 * plugin only reads the contract off the symbol). No real pool, no real SDK, no
 * second live account needed to prove the logic — exactly as the issue's test
 * plan requires.
 */

const BRIDGE_SYMBOL = Symbol.for("eliza.account-pool.coding-agent.v1");

interface FakeBridge {
  select: ReturnType<typeof vi.fn>;
  markRateLimited: ReturnType<typeof vi.fn>;
  recordUsage: ReturnType<typeof vi.fn>;
}

function installFakeBridge(selections: Array<RotationAccountSelection | null>): FakeBridge {
  let i = 0;
  const bridge: FakeBridge = {
    select: vi.fn(async () => {
      const next = i < selections.length ? selections[i] : null;
      i += 1;
      return next;
    }),
    markRateLimited: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
  return bridge;
}

function uninstallBridge(): void {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

function account(id: string): RotationAccountSelection {
  return {
    providerId: "anthropic-subscription",
    accountId: id,
    label: id,
    source: "oauth",
    strategy: "least-used",
    envPatch: { CLAUDE_CODE_OAUTH_TOKEN: `tok-${id}` },
  };
}

const enabledGetter = () => undefined;

afterEach(() => {
  uninstallBridge();
  vi.restoreAllMocks();
});

describe("isSubscriptionLimitError", () => {
  it("classifies the session handler's own limit throw", () => {
    expect(
      isSubscriptionLimitError(
        new Error(
          "[cli-inference:sdk] subscription rate limit reached: You've hit your session limit"
        )
      )
    ).toBe(true);
  });

  it("classifies 429 / 529 status envelopes", () => {
    expect(
      isSubscriptionLimitError(new ProviderApiError("upstream API Error: 429", { statusCode: 429 }))
    ).toBe(true);
    expect(
      isSubscriptionLimitError(new ProviderApiError("upstream API Error: 529", { statusCode: 529 }))
    ).toBe(true);
    expect(isSubscriptionLimitError(new Error("API Error: 429 rate limited"))).toBe(true);
  });

  it("classifies provider quota / rate-limit vocabulary", () => {
    expect(isSubscriptionLimitError(new Error("usage limit reached"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("quota exhausted for this key"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("too many requests"))).toBe(true);
  });

  it("does NOT classify non-limit errors (would burn a healthy account)", () => {
    expect(
      isSubscriptionLimitError(new Error("[cli-inference:sdk] empty completion (subtype=success)"))
    ).toBe(false);
    expect(
      isSubscriptionLimitError(
        new ProviderApiError("API Error: 400 messages: text content blocks must be non-empty", {
          statusCode: 400,
        })
      )
    ).toBe(false);
    expect(isSubscriptionLimitError(new Error("401 unauthorized"))).toBe(false);
    expect(isSubscriptionLimitError(new Error("route: model emitted no decision"))).toBe(false);
  });
});

describe("rotationAgentTypeForBackend", () => {
  it("maps only the SDK backends to a rotation agent type", () => {
    expect(rotationAgentTypeForBackend("claude-sdk")).toBe("claude");
    expect(rotationAgentTypeForBackend("codex-sdk")).toBe("codex");
    // Cold CLIs read the single on-disk login — out of scope (Gap B / CLI shim).
    expect(rotationAgentTypeForBackend("claude")).toBeNull();
    expect(rotationAgentTypeForBackend("codex")).toBeNull();
  });
});

describe("rotationEnabled", () => {
  it("defaults ON and honors the opt-out flag", () => {
    expect(rotationEnabled(() => undefined)).toBe(true);
    expect(rotationEnabled(() => "1")).toBe(true);
    for (const off of ["0", "false", "no", "off", "OFF", " Off "]) {
      expect(rotationEnabled(() => off)).toBe(false);
    }
  });
});

describe("withAccountRotation", () => {
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    backend: "claude-sdk",
    getValue: enabledGetter,
    onRotate: vi.fn(),
    ...overrides,
  });

  it("passes success straight through with no rotation", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => "hello");
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).resolves.toBe("hello");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
    expect(c.onRotate).not.toHaveBeenCalled();
  });

  it("rotates on a subscription-limit error then succeeds on the next account", async () => {
    const bridge = installFakeBridge([account("b")]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("subscription rate limit reached: session limit");
      return "answer-on-account-b";
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).resolves.toBe("answer-on-account-b");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(bridge.select).toHaveBeenCalledTimes(1);
    // Selected account b's token was applied so the fresh session re-auths as it.
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
    // The warm session bound to the limited account was torn down before retry.
    expect(c.onRotate).toHaveBeenCalledTimes(1);
    // Usage recorded against the account we rotated INTO on success.
    expect(bridge.recordUsage).toHaveBeenCalledWith("anthropic-subscription", "b", { ok: true });
  });

  it("does NOT rotate on a non-limit error — rethrows immediately to failover", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("[cli-inference:sdk] empty completion (subtype=success)");
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow("empty completion");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
    expect(c.onRotate).not.toHaveBeenCalled();
  });

  it("excludes already-tried accounts and rotates through several before succeeding", async () => {
    const bridge = installFakeBridge([account("b"), account("c")]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("429 too many requests");
      return "answer-on-account-c";
    });
    await expect(withAccountRotation(attempt, ctx() as never)).resolves.toBe("answer-on-account-c");
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(bridge.select).toHaveBeenCalledTimes(2);
    // Second select excludes the first rotated-into account (b).
    expect(bridge.select.mock.calls[1][1].exclude).toContain("b");
  });

  it("falls through to provider failover (rethrows) when the pool is exhausted", async () => {
    const bridge = installFakeBridge([account("b"), null]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    // First limit → rotate to b; b limits too → select returns null → rethrow.
    await expect(withAccountRotation(attempt, ctx() as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(bridge.select).toHaveBeenCalledTimes(2);
    // The rotated-into account b was marked rate-limited when it also limited.
    expect(bridge.markRateLimited).toHaveBeenCalledWith(
      "anthropic-subscription",
      "b",
      expect.any(Number),
      expect.any(String)
    );
  });

  it("single-account no-op: no bridge installed → single un-wrapped attempt, throw to failover", async () => {
    uninstallBridge();
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx();
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(c.onRotate).not.toHaveBeenCalled();
  });

  it("does not rotate when disabled via the opt-out flag", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx({ getValue: () => "0" });
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
  });

  it("non-rotatable backend (cold CLI) is a pass-through no-op", async () => {
    const bridge = installFakeBridge([account("b")]);
    const attempt = vi.fn(async () => {
      throw new Error("subscription rate limit reached: session limit");
    });
    const c = ctx({ backend: "claude" });
    await expect(withAccountRotation(attempt, c as never)).rejects.toThrow(
      "subscription rate limit reached"
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(bridge.select).not.toHaveBeenCalled();
  });
});
