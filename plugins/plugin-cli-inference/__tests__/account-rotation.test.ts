import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRotatedSubprocessEnv,
  isSubscriptionLimitError,
  type RotationAccountSelection,
  resetRotationStateForTests,
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
  resetRotationStateForTests();
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

  it("classifies OpenAI's classic quota envelope (inverted word order, no 429 literal)", () => {
    // The real envelope: message text alone, no statusCode on the thrown error —
    // the exact shape a codex-sdk turn surfaces. Must rotate, not tier-failover.
    expect(
      isSubscriptionLimitError(
        new Error(
          "You exceeded your current quota, please check your plan and billing details. " +
            "For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors."
        )
      )
    ).toBe(true);
    // Truncated variants: either envelope half alone still classifies.
    expect(isSubscriptionLimitError(new Error("You exceeded your current quota"))).toBe(true);
    expect(isSubscriptionLimitError(new Error("please check your plan and billing details"))).toBe(
      true
    );
    // The machine-readable error code from the JSON envelope body.
    expect(
      isSubscriptionLimitError(
        new Error('{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}')
      )
    ).toBe(true);
  });

  it("does NOT classify prose that merely talks about quotas / billing", () => {
    expect(
      isSubscriptionLimitError(
        new Error("the user asked how quotas work and whether billing resets monthly")
      )
    ).toBe(false);
    expect(
      isSubscriptionLimitError(new Error("your quota looks fine; billing details are unchanged"))
    ).toBe(false);
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

describe("buildRotatedSubprocessEnv", () => {
  it("keeps ambient process env intact while selected account auth wins in subprocess env", () => {
    const saved = {
      CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-claude-token";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
    process.env.CODEX_HOME = "/ambient/codex";
    process.env.OPENAI_API_KEY = "ambient-openai-key";

    try {
      const claudeEnv = buildRotatedSubprocessEnv("claude", {
        CLAUDE_CODE_OAUTH_TOKEN: "selected-claude-token",
      });
      expect(claudeEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe("selected-claude-token");
      expect(claudeEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(claudeEnv.PATH).toBe(process.env.PATH);

      const codexEnv = buildRotatedSubprocessEnv("codex", { CODEX_HOME: "/selected/codex" });
      expect(codexEnv.CODEX_HOME).toBe("/selected/codex");
      expect(codexEnv.OPENAI_API_KEY).toBeUndefined();
      expect(codexEnv.PATH).toBe(process.env.PATH);

      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-claude-token");
      expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-anthropic-key");
      expect(process.env.CODEX_HOME).toBe("/ambient/codex");
      expect(process.env.OPENAI_API_KEY).toBe("ambient-openai-key");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token";
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    const bridge = installFakeBridge([account("b")]);
    let calls = 0;
    const seenEnv: Array<Record<string, string | undefined> | undefined> = [];
    const attempt = vi.fn(async (env?: Record<string, string | undefined>) => {
      seenEnv.push(env);
      calls += 1;
      if (calls === 1) throw new Error("subscription rate limit reached: session limit");
      return "answer-on-account-b";
    });
    const c = ctx();
    try {
      await expect(withAccountRotation(attempt, c as never)).resolves.toBe("answer-on-account-b");
      expect(attempt).toHaveBeenCalledTimes(2);
      expect(seenEnv[0]).toBeUndefined();
      expect(seenEnv[1]?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
      expect(seenEnv[1]?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(seenEnv[1]?.PATH).toBe(process.env.PATH);
      expect(bridge.select).toHaveBeenCalledTimes(1);
      // Selected account b's token is scoped to the subprocess env only.
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-token");
      expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-key");
      // The warm session bound to the limited account was torn down before retry.
      expect(c.onRotate).toHaveBeenCalledTimes(1);
      // Usage recorded against the account we rotated INTO on success.
      expect(bridge.recordUsage).toHaveBeenCalledWith("anthropic-subscription", "b", { ok: true });
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });

  it("reuses a selected subprocess env on later turns without reselecting or mutating process.env", async () => {
    const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "ambient-token";
    const bridge = installFakeBridge([account("b")]);
    try {
      let firstCalls = 0;
      await expect(
        withAccountRotation(
          async () => {
            firstCalls += 1;
            if (firstCalls === 1) {
              throw new Error("subscription rate limit reached: session limit");
            }
            return "rotated";
          },
          ctx({ sessionKey: "stable-session" }) as never
        )
      ).resolves.toBe("rotated");

      const secondAttempt = vi.fn(async (env?: Record<string, string | undefined>) => {
        expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-b");
        return "still-on-selected-account";
      });
      await expect(
        withAccountRotation(secondAttempt, ctx({ sessionKey: "stable-session" }) as never)
      ).resolves.toBe("still-on-selected-account");

      expect(secondAttempt).toHaveBeenCalledTimes(1);
      expect(bridge.select).toHaveBeenCalledTimes(1);
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("ambient-token");
    } finally {
      if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    }
  });

  it("rotates on OpenAI's classic quota envelope (the pre-fix silent tier-failover)", async () => {
    const bridge = installFakeBridge([account("b")]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error(
          "You exceeded your current quota, please check your plan and billing details."
        );
      }
      return "answer-on-account-b";
    });
    const c = ctx({ backend: "codex-sdk" });
    await expect(withAccountRotation(attempt, c as never)).resolves.toBe("answer-on-account-b");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(bridge.select).toHaveBeenCalledTimes(1);
    expect(c.onRotate).toHaveBeenCalledTimes(1);
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
