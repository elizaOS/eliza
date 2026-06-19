import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { isConfirmed } from "../../chains/evm/actions/helpers.js";
import {
  gateWalletFinancialExecution,
  walletFinancialPendingKey,
} from "../wallet-financial-confirmation.js";

function runtimeWithCache(): IAgentRuntime {
  const cache = new Map<string, unknown>();
  return {
    agentId: "test-agent",
    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

describe("wallet-financial-confirmation", () => {
  it("never treats LLM options.confirmed as authorization", () => {
    expect(isConfirmed({ confirmed: true })).toBe(false);
    expect(isConfirmed({ parameters: { confirmed: true } })).toBe(false);
  });

  it("blocks first on-chain attempt until the user replies yes", async () => {
    const runtime = runtimeWithCache();
    const params = {
      subaction: "transfer" as const,
      chain: "base",
      amount: "0.1",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute" as const,
      dryRun: false,
    };
    const pending = await gateWalletFinancialExecution({
      runtime,
      message: message("send 0.1 ETH"),
      params,
    });
    expect(pending.proceed).toBe(false);
    if (pending.proceed) return;
    expect(pending.decision.status).toBe("pending");

    const confirmed = await gateWalletFinancialExecution({
      runtime,
      message: message("yes, confirm the transfer"),
      params,
    });
    expect(confirmed.proceed).toBe(true);
  });

  it("builds stable pending keys for identical transfer params", () => {
    const keyA = walletFinancialPendingKey({
      subaction: "transfer",
      chain: "Base",
      amount: "1",
      recipient: "0xAbCdEf0123456789012345678901234567890AbCd",
      mode: "execute",
      dryRun: false,
    });
    const keyB = walletFinancialPendingKey({
      subaction: "transfer",
      chain: "base",
      amount: "1",
      recipient: "0xabcdef0123456789012345678901234567890abcd",
      mode: "prepare",
      dryRun: false,
    });
    expect(keyA).toBe(keyB);
  });
});
