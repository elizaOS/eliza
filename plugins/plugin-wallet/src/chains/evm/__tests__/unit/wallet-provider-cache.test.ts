/**
 * EVM prompt context reads only background-refreshed wallet state.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { EVM_SERVICE_NAME } from "../../constants";
import { evmWalletProvider } from "../../providers/wallet";

const message = {} as Memory;
const state = { agentName: "Agent" } as State;

describe("evmWalletProvider cache-only prompt path", () => {
  it("returns explicit loading context without awaiting network work", async () => {
    const getCachedData = vi.fn(async () => undefined);
    const runtime = {
      getService: vi.fn((serviceName: string) =>
        serviceName === EVM_SERVICE_NAME ? { getCachedData } : null
      ),
    } as unknown as IAgentRuntime;

    const result = await evmWalletProvider.get(runtime, message, state);

    expect(getCachedData).toHaveBeenCalledOnce();
    expect(result.data).toEqual({ status: "loading" });
    expect(result.values).toMatchObject({
      walletReady: false,
      walletStatus: "loading",
    });
  });

  it("renders the cached address and balances", async () => {
    const runtime = {
      getService: vi.fn(() => ({
        getCachedData: async () => ({
          address: "0x1234",
          chains: [{ name: "Ethereum", balance: "1", symbol: "ETH" }],
        }),
      })),
    } as unknown as IAgentRuntime;

    const result = await evmWalletProvider.get(runtime, message, state);

    expect(result.text).toContain("0x1234");
    expect(result.text).toContain("Ethereum: 1 ETH");
  });
});
