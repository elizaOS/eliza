/**
 * Verifies isMultiAccountAgentType.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL as BRIDGE_SYMBOL } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountMetaFromSessionMetadata,
  diagnoseCodingAccountFallback,
  getCodingAccountBridge,
  isMultiAccountAgentType,
  resolveCodingAccountStrategy,
  selectCodingAccount,
} from "../../src/services/coding-account-selection.js";

function clearBridge() {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
}

afterEach(clearBridge);

describe("isMultiAccountAgentType", () => {
  it("is true for pool-rotated coding agents (claude/codex + opencode→cerebras)", () => {
    for (const t of ["claude", "codex", "opencode", "CLAUDE", "Codex"]) {
      expect(isMultiAccountAgentType(t)).toBe(true);
    }
  });
  it("is false for runtime/local agents and providers without a coding CLI", () => {
    // elizaos/pi-agent authenticate via their own backend; z.ai/kimi/glm have
    // no first-party coding CLI to spawn.
    for (const t of ["elizaos", "pi-agent", "zai", "glm", "kimi", ""]) {
      expect(isMultiAccountAgentType(t)).toBe(false);
    }
  });
});

describe("resolveCodingAccountStrategy", () => {
  it("normalizes known strategies", () => {
    expect(resolveCodingAccountStrategy("least-used")).toBe("least-used");
    expect(resolveCodingAccountStrategy(" Round-Robin ")).toBe("round-robin");
    expect(resolveCodingAccountStrategy("priority")).toBe("priority");
    expect(resolveCodingAccountStrategy("quota-aware")).toBe("quota-aware");
  });
  it("returns undefined for unknown / empty", () => {
    expect(resolveCodingAccountStrategy("nonsense")).toBeUndefined();
    expect(resolveCodingAccountStrategy(undefined)).toBeUndefined();
  });
});

describe("accountMetaFromSessionMetadata", () => {
  it("parses a stamped account", () => {
    const meta = accountMetaFromSessionMetadata({
      account: {
        providerId: "openai-codex",
        accountId: "acc-1",
        label: "Personal",
        source: "oauth",
        strategy: "least-used",
      },
    });
    expect(meta).toEqual({
      providerId: "openai-codex",
      accountId: "acc-1",
      label: "Personal",
      source: "oauth",
      strategy: "least-used",
    });
  });
  it("returns null when absent or malformed", () => {
    expect(accountMetaFromSessionMetadata(undefined)).toBeNull();
    expect(accountMetaFromSessionMetadata({})).toBeNull();
    expect(
      accountMetaFromSessionMetadata({ account: { providerId: 1 } }),
    ).toBeNull();
  });
});

describe("selectCodingAccount", () => {
  it("returns null when no bridge is installed", async () => {
    clearBridge();
    expect(getCodingAccountBridge()).toBeNull();
    expect(await selectCodingAccount("claude", {})).toBeNull();
  });

  it("returns null for non-multi-account agent types even with a bridge", async () => {
    const select = vi.fn(async () => ({
      providerId: "anthropic-subscription",
      accountId: "x",
      label: "x",
      source: "oauth" as const,
      strategy: "least-used",
      envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
    }));
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = { select };
    expect(await selectCodingAccount("elizaos", {})).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("returns the bridge selection + non-secret meta for a coding agent", async () => {
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      select: vi.fn(async () => ({
        providerId: "anthropic-subscription",
        accountId: "acc-work",
        label: "Work",
        source: "oauth" as const,
        strategy: "least-used",
        envPatch: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-X" },
      })),
    };
    const resolved = await selectCodingAccount("claude", { sessionKey: "s1" });
    expect(resolved?.selection.envPatch.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat-X",
    );
    expect(resolved?.meta).toEqual({
      providerId: "anthropic-subscription",
      accountId: "acc-work",
      label: "Work",
      source: "oauth",
      strategy: "least-used",
    });
    // meta carries no secret
    expect(JSON.stringify(resolved?.meta)).not.toContain("sk-ant-oat-X");
  });

  it("never throws when the bridge select rejects", async () => {
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
      select: vi.fn(async () => {
        throw new Error("pool exploded");
      }),
    };
    expect(await selectCodingAccount("codex", {})).toBeNull();
  });
});

describe("diagnoseCodingAccountFallback (#9960 loud degradation)", () => {
  function installDescribe(
    describe: () => Record<
      string,
      { providerId: string; total: number; enabled: number; healthy: number }[]
    >,
  ) {
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = { describe };
  }

  it("is silent for a benign empty/single-account host (no bridge, no accounts)", () => {
    clearBridge();
    expect(diagnoseCodingAccountFallback("claude")).toBeNull();
    installDescribe(() => ({
      claude: [
        {
          providerId: "anthropic-subscription",
          total: 0,
          enabled: 0,
          healthy: 0,
        },
      ],
    }));
    // Zero accounts connected → single-account by choice, not a misconfig.
    expect(diagnoseCodingAccountFallback("claude")).toBeNull();
  });

  it("is silent for non-multi-account agent types", () => {
    installDescribe(() => ({
      claude: [
        {
          providerId: "anthropic-subscription",
          total: 2,
          enabled: 0,
          healthy: 0,
        },
      ],
    }));
    expect(diagnoseCodingAccountFallback("elizaos")).toBeNull();
  });

  it("warns loudly when accounts are connected but NONE are healthy", () => {
    installDescribe(() => ({
      codex: [
        { providerId: "openai-codex", total: 2, enabled: 2, healthy: 0 },
        { providerId: "openai-api", total: 0, enabled: 0, healthy: 0 },
      ],
    }));
    const msg = diagnoseCodingAccountFallback("codex");
    expect(msg).toContain("codex");
    expect(msg).toContain("2 account(s) connected but 0 healthy");
    expect(msg).toContain("single-account credentials");
  });

  it("stays silent when at least one account is healthy (rotation works)", () => {
    installDescribe(() => ({
      claude: [
        {
          providerId: "anthropic-subscription",
          total: 2,
          enabled: 2,
          healthy: 1,
        },
      ],
    }));
    expect(diagnoseCodingAccountFallback("claude")).toBeNull();
  });

  it("never throws when describe() throws", () => {
    installDescribe(() => {
      throw new Error("describe exploded");
    });
    expect(diagnoseCodingAccountFallback("codex")).toBeNull();
  });
});
