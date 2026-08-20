/**
 * Unit tests for the Signal multi-account resolution helpers in `accounts.ts`,
 * covering case-insensitive account-id normalization between enumeration
 * (`listSignalAccountIds`) and lookup (`getAccountConfig`/`resolveSignalAccount`).
 * Regression coverage for issue #22680, where a non-lowercase account key
 * silently dropped its per-account overrides. Uses a hand-built fake runtime;
 * no live signal-cli.
 */
import type { Character, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveSignalAccount,
  type SignalMultiAccountConfig,
} from "./accounts";

function createRuntime(
  signal?: SignalMultiAccountConfig,
  env?: Record<string, string | undefined>
): IAgentRuntime {
  const character: Partial<Character> = {
    settings: signal ? { signal } : {},
  };
  const settings = env ?? {};
  return {
    agentId: "agent-1",
    character: character as Character,
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

describe("listSignalAccountIds", () => {
  it("normalizes configured keys to their lowercased lookup ids", () => {
    const rt = createRuntime({
      accounts: {
        Work: { account: "+15550001111" },
        personal: { account: "+15550002222" },
      },
    });
    expect(listSignalAccountIds(rt)).toEqual(["personal", "work"]);
  });

  it("falls back to the default id when no accounts are configured", () => {
    expect(listSignalAccountIds(createRuntime())).toEqual(["default"]);
  });
});

describe("resolveSignalAccount case-insensitive lookup (issue #22680)", () => {
  it("resolves an uppercase-keyed account's per-account overrides", () => {
    const rt = createRuntime({
      accounts: {
        Work: {
          enabled: true,
          account: "+15550001111",
          httpUrl: "http://127.0.0.1:9999",
        },
      },
    });

    // The configured key ("Work") and the normalized lookup id ("work") must
    // both surface the same merged config instead of falling back to `{}`.
    for (const lookup of ["Work", "work", "WORK"]) {
      const resolved = resolveSignalAccount(rt, lookup);
      expect(resolved.accountId).toBe("work");
      expect(resolved.account).toBe("+15550001111");
      expect(resolved.baseUrl).toBe("http://127.0.0.1:9999");
      expect(resolved.configured).toBe(true);
      expect(resolved.enabled).toBe(true);
    }
  });

  it("includes the uppercase-keyed account in the enabled list", () => {
    const rt = createRuntime({
      accounts: {
        Work: {
          enabled: true,
          account: "+15550001111",
          httpUrl: "http://127.0.0.1:9999",
        },
      },
    });
    const enabled = listEnabledSignalAccounts(rt);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]?.accountId).toBe("work");
    expect(enabled[0]?.account).toBe("+15550001111");
    expect(enabled[0]?.configured).toBe(true);
  });

  it("throws instead of double-counting mixed-case duplicate keys", () => {
    const rt = createRuntime({
      accounts: {
        Work: { enabled: true, account: "+15550001111" },
        work: { enabled: true, account: "+15550003333" },
      },
    });
    // Two distinct configured keys that collapse to the same normalized id are
    // ambiguous; enumeration must fail loudly rather than start two accounts.
    expect(() => listSignalAccountIds(rt)).toThrowError(/collide after normalization/i);
    expect(() => listEnabledSignalAccounts(rt)).toThrowError(/collide after normalization/i);
    expect(() => resolveSignalAccount(rt, "work")).toThrowError(/collide after normalization/i);
  });

  it("rejects whitespace and case variants through every resolver entry point", () => {
    const rt = createRuntime({
      accounts: {
        Work: { enabled: true, account: "+15550001111" },
        " work ": { enabled: true, account: "+15550003333" },
      },
    });
    for (const resolve of [
      () => listSignalAccountIds(rt),
      () => listEnabledSignalAccounts(rt),
      () => resolveSignalAccount(rt, "WORK"),
    ]) {
      expect(resolve).toThrowError(/collide after normalization/i);
    }
  });

  it("still resolves all-lowercase configs unchanged", () => {
    const rt = createRuntime({
      accounts: {
        work: {
          enabled: true,
          account: "+15550001111",
          httpUrl: "http://127.0.0.1:9999",
        },
      },
    });
    const resolved = resolveSignalAccount(rt, "work");
    expect(resolved.accountId).toBe("work");
    expect(resolved.account).toBe("+15550001111");
    expect(resolved.configured).toBe(true);
    expect(listEnabledSignalAccounts(rt)).toHaveLength(1);
  });
});
